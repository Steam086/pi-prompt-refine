# RPC slash 宿主复验

在实际使用的稳定版 T3 Code 上验证[当前 RPC 流程](rpc-slash-verification.md)，其他 RPC 宿主单独记录结果。使用未打补丁的宿主、隔离 Pi profile 和确定性本地 stub，记录插件提交、宿主与 Pi 版本、桌面或浏览器版本以及窗口尺寸。

1. 输入 `/refine optimize <draft>`，检查短回执、后台运行和原线程结果交付。分别在发起 turn 已结束、切换线程、输入未发送草稿、已有 Pi 对话框时试验。确认原草稿可恢复，候选不会投到其他线程或进入主 Agent transcript。记录宿主是否抢占正在输入的 composer。
2. 用短文本与接近宿主可接受上限的长文本复验，包括中文、空行、长 URL、代码围栏和首尾空白。在窄窗口读到末尾，复制整个候选并与 fixture 逐字符对比。区分客户端提交时 trim 和结果交付时失真。记录实际测到的长度、不完整交付、关闭延迟或仅支持手动查看的情况。
3. 使用回执中的完整重看命令，验证重开不提交模型。改动预览文字后关闭，再重开确认候选保持原样。切换会话或重载后检查旧标识失效。
4. 人工验证中文 IME 组合输入、自动预览切换时的焦点和草稿恢复。测试覆盖和历史结果分别记录。 [RPC 集成测试](../test/integration/rpc-slash.test.ts) · [验收记录](rpc-slash-verification.md#evidence-and-outstanding-checks)

真实 Provider 调用和生产宿主部署／重启各需单独授权。
