const { Agent } = require('undici');

const finalDispatcher = new Agent({
  connections: 64, 
  pipelining: 1,
  headersTimeout: 30_000, 
  bodyTimeout: 60_000,
  connectTimeout: 10_000,
});

// Отдаем сам объект напрямую, как ждет @xmcl
module.exports = { 
  farcipalAgent: finalDispatcher 
};