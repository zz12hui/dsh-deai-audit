# deai-audit · 文案去 AI 味 DSH 工具插件

在 DSH 对话里给中文文案做「AI 味」审计：六维打分、逐句打标、给改法，支持六种文体。插件在 DSH 启动时注册两个**模型可见工具**，装好后直接说「审一下这段文案」即可。

## 安装

```bash
git clone https://github.com/zz12hui/dsh-deai-audit.git
```

1. 把仓库内容复制到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-local-deai-audit\`（`~/.dsh/profiles/desktop/node_modules/` 同理）。
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: deai-audit-panel
         name: 'dsh-local-deai-audit'
   ```

3. **重启 DSH**（关闭窗口含托盘退出 → 重开 → 恢复会话）。插件在启动时注册工具，刷新页面不会加载它。
4. 验证：说「审一下这段文案」，助手应直接调用 `deai_audit` 并贴出分数与打标（AI 样例约 58.6 分，人话样例约 7.1 分）。

## 工具

| 工具 | 作用 | 参数 |
|---|---|---|
| `deai_audit` | 六维 AI 味评分 + 逐句打标 + 改法 | `text`（必填）、`genre`（resume/report/article/marketing/bid/email）、`detail`（summary/full） |
| `deai_audit_config` | 配置管理 | `action`: get / genres / set / reset；`config`（set 时传 JSON） |

## 配置

默认值在插件包 `config/deai-config.json`，用户覆盖写 `~/.dsh/deai-audit-config.json`（用 `deai_audit_config` 的 `set`/`reset`，或直接改文件）。配置覆盖：词表、正则、阈值、分档、六种文体的六维权重。

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

- `node --check index.js` 通过；桩测试：`inject: ['tools']`、两个工具注册/执行/渲染、配置读取全通过（AI 样例 58.6 / 人话样例 7.1）；
- profile 解析：`createRequire(profile/package.json).resolve('dsh-local-deai-audit')` 命中；
- 已在真实 DSH 会话中调用 `deai_audit` / `deai_audit_config`，返回分数、逐句打标与配置结果正常。

## 回滚

删除 `cordis.patch.yml` 末尾的 `deai-audit-panel` 插入块和 `node_modules/dsh-local-deai-audit` 目录，重启 DSH；想彻底清理再删掉 `~/.dsh/deai-audit-config.json`。

## License

MIT
