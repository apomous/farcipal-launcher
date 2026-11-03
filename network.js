const { Agent } = require('undici');

const finalDispatcher = new Agent({
  connections: 8, // 8 соединений — безопасный лимит для VPN
  pipelining: 1,
  headersTimeout: 30_000, // Уменьшили таймауты, чтобы быстрее отваливались мертвые соединения
  bodyTimeout: 60_000,
  connectTimeout: 10_000,
});

// ЭКСПОРТИРУЕМ ПРАВИЛЬНО: объект с полем dispatcher!
module.exports = { 
  farcipalAgent: { dispatcher: finalDispatcher } 
};