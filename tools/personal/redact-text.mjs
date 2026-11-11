/** Mask common credentials in text/JSON without exposing them in memory or MCP. */
export function scrubText(value){
 return String(value??'')
  .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[закрытый ключ скрыт]')
  .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,'[скрыто]')
  .replace(/Bearer[ \t]+[^\s"'\\,;}\]]+/gi,'Bearer [скрыто]')
  .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/g,'$1[скрыто]@')
  .replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|key|token|secret|password|authorization)=)[^&\s"'<>]+/gi,'$1[скрыто]')
  .replace(/((?:["'])?(?:[a-z][a-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|private[_-]?key|client[_-]?secret)(?:["'])?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[(?:скрыто|закрытый ключ скрыт)\]|[^\s,;}\]]+)/gi,(_all,prefix,secret)=>prefix+(secret.startsWith('[')?secret:['"',"'"].includes(secret[0])?secret[0]+'[скрыто]'+secret[0]:'[скрыто]'));
}
