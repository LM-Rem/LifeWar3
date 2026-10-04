export const CHAT_MAX_LENGTH = 500;
export const CONVERSATION_LIMIT = 200;

export function validateChatText(value) {
  if (typeof value !== 'string') throw new Error('请输入聊天内容');
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!text) throw new Error('请输入聊天内容');
  if (text.length > CHAT_MAX_LENGTH) throw new Error(`每条消息最多 ${CHAT_MAX_LENGTH} 字`);
  return text;
}

export function mergeConversation(current, incoming, reset = false) {
  const records = new Map((reset ? [] : current).filter(entry=>entry.kind==='chat').map(entry=>[entry.sequence,entry]));
  for (const entry of incoming) if(entry.kind==='chat') records.set(entry.sequence,entry);
  return [...records.values()].sort((a,b)=>a.sequence-b.sequence).slice(-CONVERSATION_LIMIT);
}
