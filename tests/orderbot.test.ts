import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OrderBot } from '../src/promo/orderBot';
import { WalletStore } from '../src/promo/walletStore';
import { Db } from '../src/db/index';
import type { PromoConfig } from '../src/types';

const MNEMONIC = 'test test test test test test test test test test test junk';
// derived deposit addresses for order ids allocated in-sequence (indices 0, 1, …)
const DEP0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

const PROMO: PromoConfig = {
  enabled: true,
  treasuryAddress: '0xpay0000000000000000000000000000000000aa',
  confirmations: 3,
  leaderboardSize: 12,
  pendingMinutes: 60,
  adminChatIds: [],
  tiers: {
    top3: { maxRank: 3, slots: 1, bumpMinutes: 30, prices: { '3': 0.1, '6': 0.18, '24': 0.6 } },
    top8: { maxRank: 8, slots: 5, bumpMinutes: 60, prices: { '3': 0.08, '6': 0.14, '24': 0.45 } },
    top12: { maxRank: 12, slots: 4, bumpMinutes: 90, prices: { '3': 0.06, '6': 0.1, '24': 0.35 } },
  },
};

const CA = '0x6e7e0db14d23144ef3e78d3294aa408ac38427b8';

function dm(text: string, chatId = 777, type = 'private') {
  return { update_id: 1, message: { chat: { id: chatId, type }, text } };
}
function press(data: string, chatId = 777) {
  return { update_id: 2, callback_query: { id: 'cbq1', data, message: { chat: { id: chatId } } } };
}

describe('OrderBot', () => {
  let db: Db;
  let dir: string;
  let wallets: WalletStore;
  let sent: Array<{ chatId: number; text: string; buttons?: any }>;
  let acks: string[];
  let bot: OrderBot;
  let tg: any;
  const symbolFn = async (addr: string) => (addr === CA ? 'BLEP' : null);

  beforeEach(() => {
    db = new Db(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'rbh-ob-'));
    wallets = new WalletStore(join(dir, 'wallets.json'), MNEMONIC);
    sent = [];
    acks = [];
    tg = {
      sendTo: async (chatId: number, p: any) => {
        const payload = typeof p === 'string' ? { text: p } : p;
        sent.push({ chatId, text: payload.text, buttons: payload.buttons });
        return { ok: true };
      },
      answerCallbackQuery: async (id: string) => { acks.push(id); },
    };
    bot = new OrderBot(tg, db, PROMO, wallets, symbolFn);
  });

  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('/trend prompts for the token CA', async () => {
    await bot.handleUpdate(dm('/trend'), 1000);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(777);
    expect(sent[0].text).toContain('contract address');
  });

  it('a valid CA replies with the 3×3 tier/duration menu and resolved symbol', async () => {
    await bot.handleUpdate(dm('/trend'), 1000);
    await bot.handleUpdate(dm(CA), 1000);
    expect(sent).toHaveLength(2);
    const menu = sent[1];
    expect(menu.text).toContain('BLEP');
    expect(menu.buttons).toHaveLength(3); // one row per tier
    expect(menu.buttons[0]).toHaveLength(3); // one button per duration
    expect(menu.buttons[0][0]).toMatchObject({ callback_data: 'buy:top3:3' });
    expect(menu.buttons[0][0].text).toContain('0.1 ETH');
    expect(menu.buttons[2][2]).toMatchObject({ callback_data: 'buy:top12:24' });
  });

  it('rejects an invalid CA with an error message and no menu', async () => {
    await bot.handleUpdate(dm('/trend'), 1000);
    await bot.handleUpdate(dm('not-a-ca'), 1000);
    expect(sent).toHaveLength(2);
    expect(sent[1].text.toLowerCase()).toContain('valid');
    expect(sent[1].buttons).toBeUndefined();
  });

  it('pressing a tier button creates a pending order with its own deposit address and clean amount', async () => {
    await bot.handleUpdate(dm('/trend'), 1000);
    await bot.handleUpdate(dm(CA), 1000);
    await bot.handleUpdate(press('buy:top3:6'), 2000);

    expect(acks).toEqual(['cbq1']);
    const orders = db.pendingOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ chatId: 777, address: CA, symbol: 'BLEP', tier: 'top3', hours: 6 });
    // clean 0.18 ETH price — no dust, since the address is unique
    expect(orders[0].amountWei).toBe('180000000000000000');
    // first order → derivation index 0 → the known deposit address
    expect(orders[0].depositAddress).toBe(DEP0);
    expect(orders[0].derivIndex).toBe(0);
    expect(wallets.get(orders[0].id)?.address).toBe(DEP0);

    const quote = sent[2];
    expect(quote.text).toContain('0.18 ETH');
    expect(quote.text).toContain(DEP0); // pay to the deposit address, not the treasury
    expect(quote.text).not.toContain(PROMO.treasuryAddress);
    expect(quote.text).toContain('60 min');
  });

  it('a sold-out tier refuses the order', async () => {
    await bot.handleUpdate(dm('/trend', 111), 1000);
    await bot.handleUpdate(dm(CA, 111), 1000);
    await bot.handleUpdate(press('buy:top3:6', 111), 2000); // takes the single top3 slot

    await bot.handleUpdate(dm('/trend', 222), 3000);
    await bot.handleUpdate(dm(CA, 222), 3000);
    await bot.handleUpdate(press('buy:top3:3', 222), 4000);

    expect(db.pendingOrders()).toHaveLength(1); // second order refused
    const last = sent[sent.length - 1];
    expect(last.chatId).toBe(222);
    expect(last.text.toLowerCase()).toContain('sold out');
  });

  it('ignores group-chat messages entirely', async () => {
    await bot.handleUpdate(dm('/trend', 777, 'supergroup'), 1000);
    expect(sent).toHaveLength(0);
  });

  describe('admin free listing', () => {
    const ADMIN = 999;
    const adminBot = () => new OrderBot(tg, db, { ...PROMO, adminChatIds: [ADMIN] }, wallets, symbolFn);

    it('an admin tapping a tier comps a free order — no payment quote, no deposit wallet', async () => {
      const b = adminBot();
      await b.handleUpdate(dm('/trend', ADMIN), 1000);
      await b.handleUpdate(dm(CA, ADMIN), 1000);
      await b.handleUpdate(press('buy:top3:24', ADMIN), 2000);

      const comp = db.pendingCompOrders();
      expect(comp).toHaveLength(1);
      expect(comp[0]).toMatchObject({ chatId: ADMIN, address: CA, symbol: 'BLEP', tier: 'top3', hours: 24, comp: 1 });
      expect(comp[0].depositAddress).toBe(''); // no deposit wallet for a free listing
      expect(wallets.get(comp[0].id)).toBeNull();

      const reply = sent[sent.length - 1];
      expect(reply.text.toLowerCase()).toContain('listed');
      expect(reply.text).not.toContain('Send'); // not a payment quote
    });

    it('an admin bypasses a sold-out tier', async () => {
      const b = adminBot();
      // fill the single top3 slot with a normal paid order from a non-admin
      await b.handleUpdate(dm('/trend', 111), 1000);
      await b.handleUpdate(dm(CA, 111), 1000);
      await b.handleUpdate(press('buy:top3:6', 111), 2000);
      expect(db.pendingOrders()).toHaveLength(1);

      // admin can still comp top3 despite it being sold out
      await b.handleUpdate(dm('/trend', ADMIN), 3000);
      await b.handleUpdate(dm(CA, ADMIN), 3000);
      await b.handleUpdate(press('buy:top3:6', ADMIN), 4000);

      expect(db.pendingCompOrders()).toHaveLength(1);
      expect(sent[sent.length - 1].text.toLowerCase()).not.toContain('sold out');
    });

    it('a non-admin is never comped (still gets a paid quote)', async () => {
      const b = adminBot();
      await b.handleUpdate(dm('/trend', 777), 1000);
      await b.handleUpdate(dm(CA, 777), 1000);
      await b.handleUpdate(press('buy:top3:6', 777), 2000);
      expect(db.pendingCompOrders()).toHaveLength(0);
      expect(db.pendingOrders()[0].comp).toBe(0);
      expect(sent[sent.length - 1].text).toContain('Send'); // payment quote
    });
  });
});
