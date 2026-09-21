import { redactSensitiveText } from "../evaluation/redaction.js";
import { stripUnsafeControls } from "./candidate.js";

/** 公开问题正文允许普通代码赋值；凭据与终端控制字符仍不允许。 */
export function assertPublicRetrievalText(value: string): void {
  if (stripUnsafeControls(value) !== value) throw new Error("Public retrieval text contains unsafe control characters");
  // 引文前缀仅避开通用行首环境赋值规则，不关闭内联凭据或已注册密钥检测。
  const quoted = value.replace(/^/gm, "> ");
  if (redactSensitiveText(quoted) !== quoted) throw new Error("Public retrieval text contains a potential secret");
}
