# VSCursed

把 [Cordis](https://github.com/cordiverse/cordis) 接入 VSCodium 内部：插件以 VS Code 扩展（VSIX）分发，在
renderer、main、shared process、extension host 四个运行域中作为 Cordis 插件运行，直接使用这些进程里正在运行的
VS Code 服务。

## 运行域

每个进程各有一个 Cordis 根上下文，由 `@vscursed/runtime` 组装：

| 运行域                | 插件集合                                         | 配置来源                       |
| --------------------- | ------------------------------------------------ | ------------------------------ |
| renderer              | 窗口的 `IExtensionService`（遵循工作区启用状态） | 窗口的 `IConfigurationService` |
| extension host        | 该宿主自己的扩展注册表                           | `ExtHostConfiguration`         |
| main / shared process | 任一已连接窗口启用的插件之并集                   | 用户级 `IConfigurationService` |

插件的装载、配置更新、卸载都交给 Cordis Loader：运行域把「启用的扩展 × `vscursed.plugins` 配置」写成
Loader 根组的条目列表（`loader.root.update()`），Loader 负责创建、`fiber.update()` 重启、移除。模块来源通过
覆写 `Loader.import()` 提供；Vite+ 成功完成插件的某个运行域构建后通知开发中的 VSCodium，renderer 协调该运行域
从 registry 删除旧插件并执行 `entry.refresh()`，新模块以带修订号的 URL 重新导入，配置保持不变。

## 插件扩展

```jsonc
// package.json
{
  "publisher": "vscursed",
  "name": "sample-realms",
  "engines": { "vscode": "^1.135.0" },
  "vscursed": {
    "renderer": "./dist/renderer.js",
    "sharedProcess": "./dist/sharedProcess.js",
  },
  "files": ["dist"],
}
```

每个模块是一个普通 Cordis 插件（`apply`/`inject`/`Config`，或默认导出）。`vscursed.plugins` 以扩展 id 为键给
所有运行域提供同一份配置，各运行域的 `Config`（任何实现 Standard Schema 的库，例如 zod）各自校验所需的键。
各运行域上报 `Config` 的 Standard JSON Schema，renderer 合并后注册为 `vscursed.plugins` 的 settings.json
补全与校验；开发时替换模块会同步更新 schema。

```jsonc
// settings.json
"vscursed.plugins": {
  "vscursed.sample-realms": { "label": "Clock", "interval": 500 }
}
```

安装时 renderer 检查新扩展的 `vscursed` 字段与模块文件；卸载时若插件的清理抛错或超时，extension host
中的插件会请求重启 extension host，renderer 中的插件会请求重新加载窗口。

### 类型边界

- **VS Code 服务**：`import { IStatusbarService } from 'vscode-internal/vs/workbench/services/statusbar/browser/statusbar.js'`，
  再 `ctx.vscode.get(IStatusbarService)`。类型来自 VSCodium 源码；构建时 `vscode-internal` 导入只提供服务标识符
  （运行时从运行域登记的标识符中取得，与 VS Code 自己使用的是同一个对象）和枚举值，导入其他值会使构建失败。
- **方法拦截**：`ctx.interceptor.around(target, 'method', function (next, ...args) { ... })`。同一方法上的多层按注册
  顺序组合，每层是注册插件的 effect，插件可按任意顺序卸载，最后一层离开后恢复原属性描述符。
- **跨运行域通道**：在 `@vscursed/api` 的 `Channels` 上声明通道，`ctx.bridge.provide(name, api)` 提供，
  `ctx.bridge.connect(realm, name)` 取得异步代理；`on*` 成员是事件，订阅随调用方 fiber 释放。renderer 是窗口的路由
  中心：renderer 与 main / shared process 之间走 VS Code IPC 通道 `vscursed`，与 extension host 之间走内部命令。
- **共享模块**：插件包里的 `cordis`、`@vscursed/api` 不打包，链接到运行域自身的实例。

示例见 [plugins/sample-realms](plugins/sample-realms)（四个运行域与通道）和
[plugins/sample-command-log](plugins/sample-command-log)（与前者拦截同一方法）。

## 仓库结构

```
packages/api       插件可见的契约：VSCode 服务网关、Interceptor、Bridge、清单格式
packages/runtime   四个运行域的组装（kernel/ 与 VS Code 无关，vscode/ 为适配层），打包进 VSCodium 源码树
packages/build     插件的 Vite+ pack 预设、vscode-internal 与共享模块的 Rolldown 插件、VSIX 打包
plugins/*          示例插件扩展
upstream/vscodium  固定版本的 VSCodium（子模块），其 vscode/ 为稳定工作目录
upstream/patches   对 VSCodium 源码的全部改动
scripts/           上游维护与开发启动
```

依赖的源码改动用 pnpm 的 `patchedDependencies` 保存在 `patches/`：`@cordisjs/plugin-loader` 在模块加载时就用
`new Function` 编译 `!!js` 求值器，renderer 的 Trusted Types 会因此让整个工作台加载失败；补丁把编译推迟到第一次求值。

补丁只包含运行域接入：`src/vs/vscursed/runtime/*.d.ts` 契约、四个组合根各一行启动调用，以及让 extension host
在退出前等待运行域卸载的 `joinTermination`。运行时包由 Rolldown 输出到 `src/vs/vscursed/runtime/`（被补丁的
`.gitignore` 忽略），VS Code 自己的转译与生产打包照常处理它。

## 命令

一次性准备上游（约 20 分钟；VSCodium 的 `get_repo.sh`/`prepare_vscode.sh` 安装依赖与原生模块，随后应用补丁、
复制图标字体、转译客户端、编译内置扩展、下载 Electron 与内置市场扩展）：

```sh
pnpm install
pnpm upstream prepare
```

日常开发：

```sh
pnpm dev                 # 构建并监视运行时，以 .vscursed/ 下的独立配置启动 VSCodium
pnpm dev -- <folder>     # 其余参数交给 VSCodium
pnpm build               # 运行时写入 VSCodium 源码树，插件打包为 VSIX
pnpm check               # oxfmt 检查、类型检查、单元测试、补丁文件类型检查
pnpm fmt
```

启动后通过命令面板的 `Developer: Install Extension from Location...` 按需安装插件工作区，随后在 Extensions
界面控制启停。需要 HMR 的插件在 VSCodium 集成终端中单独运行 `pnpm exec vp pack --watch`；Vite+ 每次成功
构建后，成功完成构建的运行域会热替换插件，并保留当前配置。修改 `package.json` 中的 `vscursed` 清单后，
运行 `VSCursed: Reload Plugin` 重新读取清单并协调各个运行域。

修改 VSCodium 源码：

```sh
pnpm upstream watch      # VS Code 自带的增量转译
pnpm upstream diff       # 把工作目录改动写回 upstream/patches（新文件用 --new NN-name 归入新补丁）
pnpm upstream apply      # 重置到准备好的基线并重新应用补丁、转译
pnpm upstream check      # 用 VS Code 的编译器与选项检查补丁涉及的文件
pnpm upstream package    # VSCodium 的生产打包
```

插件模块的改动由 Vite+ 构建完成通知触发热替换；插件清单的改动由 `VSCursed: Reload Plugin` 应用。运行时自身
的改动在重新加载窗口（renderer）或重启（其他运行域）后生效。
这些重操作都在限制内存的 systemd scope 中运行（`VSCURSED_SCOPE_MEMORY`、`VSCURSED_ELECTRON_MEMORY`、
`VSCURSED_MAX_OLD_SPACE_SIZE`）。

若 Chromium 无法启用沙箱（`chrome-sandbox` 不属于 root 且 AppArmor 限制了用户命名空间），`pnpm dev` 会以
`--no-sandbox` 启动并给出修复命令。

## 已知限制

- 只支持本地 Node extension host；远程与 Web Worker extension host 不加载插件模块。
- main 与 shared process 服务所有窗口，只读取用户级配置。
- 插件模块必须是单个自包含的 ES 模块（修订号写在 URL 上）；renderer 中不可 `eval`（Trusted Types），
  zod 需 `z.config({ jitless: true })`。
- `vsce` 要求贡献命令等隐式激活事件的扩展带 `main`，因此纯 Cordis 扩展不宜贡献命令。
