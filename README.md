# deai-audit DSH 工具插件

DSH 启动时注册两个**模型可见工具**，对话里直接可用：

| 工具 | 作用 | 参数 |
|---|---|---|
| `deai_audit` | 六维 AI 味评分 + 逐句打标 + 改法 | `text`（必填）、`genre`（resume/report/article/marketing/bid/email）、`detail`（summary/full） |
| `deai_audit_config` | 配置管理 | `action`: get / genres / set / reset；`config`（set 时传 JSON） |

配置不是主界面，只是配套：默认值在插件包 `config/deai-config.json`，用户覆盖写 `~/.dsh/deai-audit-config.json`（`deai_audit_config` 的 set/reset，或直接改文件）。

## 生效方式

**重启 DSH**（关闭窗口含托盘退出 → 重开 → 恢复会话）。插件在启动时注册工具，刷新页面不会加载它。

验证：重启后说「审一下这段文案」，助手应直接调用 `deai_audit` 并贴出分数/打标（AI 样例约 58.6 分，人话样例约 7.1 分）。

## 安装位置

| 内容 | 路径 |
|---|---|
| 源码 | `F:\zz12hui\output\plugin\dsh-local-deai-audit\` |
| 已安装 | `C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-local-deai-audit\` |
| profile 补丁 | `C:\Users\Administrator\.dsh\profiles\desktop\cordis.patch.yml` 末尾 `deai-audit-panel` 行 |
| 备份 | `F:\zz12hui\output\plugin\_backup\` |

## 回滚

```powershell
& "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe" `
  "F:\zz12hui\output\plugin\rollback_plugin.py"
```

删除 patch 行 + 插件目录；重启后工具消失。

## 结构

```
dsh-local-deai-audit/
├── package.json     dsh.bundle.patch（Host 工具插件，无 client 半）
├── cordis.patch.yml 注册插件行
├── index.js         apply(ctx) 注册 deai_audit / deai_audit_config，内含评分引擎
├── config/deai-config.json  默认配置（词表/正则/阈值/分档/六种文体权重）
├── locale/zh.json   插件清单显示名/描述
├── locale/en.json
└── icon.svg
```

## 已验证

- `node --check index.js` 通过；
- 桩测试：`inject: ['tools']`、两个工具注册、执行、渲染、配置读取全通过（58.6 / 7.1）；
- profile 解析测试：`createRequire(profile/package.json).resolve('dsh-local-deai-audit')` 命中；
- 临时 profile `dsh --profile <tmp> --dump-config` 合成成功。

## 未验证

- 重启后模型工具列表是否出现（需要重启一次人工确认）；
- 工具在真实会话中的调用效果（重启后第一次使用验证）。

## 发布前要补

- `package.json` 改 `name`（别用 dsh-local-*）、补 `version`/`repository`/`LICENSE`/`README`；
- 确认目标 DSH 版本兼容 `ctx.tools`（当前实现直接传 JSON Schema，无包依赖）；
- 若要上市场，按市场要求提供 `dsh.bundle` 与图标（已就位）。
