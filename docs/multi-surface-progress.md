# 多入口实施交接

第一切片从 `563073b` 开始，S1–S4 的应用契约、原生适配及事件传输落在 `ace0615`。S5–S6 增加独立 Web 子包、离线验证和[隔离真实宿主验收](multi-surface-acceptance.md)。现行范围见[应用接口](application-api.md)。

交付期间发现原有整份 JSON/base64 暂存会因转义开销拒绝本应合法的结果。改为核心按需编码分页后，用最坏转义数据验证了完整往返和帧边界。另一项浏览器回归由运行回执早于下拉选项触发，实际修复与验证见[宿主证据](multi-surface-acceptance.md#自动化浏览器证据)。两项均有可执行[分页测试](../test/unit/output-paging.test.ts)和[桥接回归](../packages/pi-web/test/bridge.test.mjs)。

Web 发布和部署仍按[路线图](roadmap.md#暂缓发布的-web-集成)跟踪。
