import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OrderBot } from '../src/promo/orderBot';
import { Db } from '../src/db/index';
import type { PromoConfig } from '../src/types';

const PROMO: PromoConfig = {
  enabled: true,
  paymentAddress: '0xpay0000000000000000000000000000000000aa',
  confirmations: 3,
  leaderboardSize: 12,
  pendingMinutes: 60,
  tiers: {
    top3: { maxRank: 3, slots: 1, prices: { '3': 0.1, '6': 0.18, '24': 0.6 } },
    top8: { maxRank: 8, slots: 5, prices: { '3': 0.08, '6': 0.14, '24': 0.45 } },
    top12: { maxRank: 12, slots: 4, prices: { '3': 0.06, '6': 0.1, '24': 0.35 } },
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
  let sent: Array<{ chatId: number; text: string; buttons?: any }>;
  let acks: string[];
  let bot: OrderBot;

  beforeEach(() => {
    db = new Db(':memory:');
    sent = [];
    acks = [];
    const tg = {
      sendTo: async (chatId: number, p: any) => {
        const payload = typeof p === 'string' ? { text: p } : p;
        sent.push({ chatId, text: payload.text, buttons: payload.buttons });
        return { ok: true };
      },
      answerCallbackQuery: async (id: string) => { acks.push(id); },
    };
    bot = new OrderBot(tg, db, PROMO, async (addr) => (addr === CA ? 'BLEP' : null), () => 0);
  });

  afterEach(() => db.close());

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

  it('pressing a tier button creates a pending order and quotes the unique amount + wallet', async () => {
    await bot.handleUpdate(dm('/trend'), 1000);
    await bot.handleUpdate(dm(CA), 1000);
    await bot.handleUpdate(press('buy:top3:6'), 2000);

    expect(acks).toEqual(['cbq1']);
    const orders = db.pendingOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ chatId: 777, address: CA, symbol: 'BLEP', tier: 'top3', hours: 6 });
    // 0.18 ETH + minimum dust (rng()=0) = 0.180000001
    expect(orders[0].amountWei).toBe('180000001000000000');

    const quote = sent[2];
    expect(quote.text).toContain('0.180000001');
    expect(quote.text).toContain(PROMO.paymentAddress);
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
});
