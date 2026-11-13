// Every sender implements the same interface:
//   state, isReady(), start(), stop(), resolveRecipient(input) -> { jid, name },
//   newMessageId(), send(jid, text, { messageId }) -> waId | null,
//   requestPairingCode(phone), logout(); emits 'ready', 'ack', 'disconnected', 'logged_out', 'conflict'.
// To add a transport, implement that interface, branch on config.sender here and allow it in config.js.
export async function createSender({ config, db, logger }) {
  switch (config.sender) {
    case 'baileys': {
      const { BaileysSender } = await import('./baileys.js');
      return new BaileysSender({ db, logger });
    }
    default:
      throw new Error(`Unknown sender "${config.sender}".`);
  }
}
