# dsh-remote · 局域网访问

给 DeepSeek Harness 加一个页面：显示本机的局域网访问地址和二维码，手机扫一下就能打开电脑上的 DSH。

端口固定使用 DSH 的默认端口 **3080**（见 [端口说明](#端口)）。

## 为什么需要它

DSH 的 Web 服务只监听一个具体地址，并且明确拒绝 `0.0.0.0` 这类通配绑定；桌面版更是直接以 `--host 127.0.0.1 --port 0` 启动，端口由系统分配。所以手机连不上电脑上的 DSH，原因不在端口号，而在**监听地址**只覆盖了回环。

dsh-remote 在**局域网地址**上监听 3080，把请求反向代理到本机 DSH 真正监听的端口。因为绑的是另一个地址，它和本机回环上的 DSH 互不影响：

```
手机 ──► 192.168.x.x:3080（本插件网关）──► 127.0.0.1:<DSH 端口>（DSH 自己）
本机 ──► 127.0.0.1:<DSH 端口>（DSH 自己，完全不受影响）
```

## 功能

- **局域网 IP 自动识别**：按「手机最可能访问到」的顺序排列网卡，物理 Wi-Fi / 有线优先，WSL / 虚拟机 / VPN 隧道降权。
- **多网卡手动切换**：一个下拉框切换，选择会被保存，重启后继续使用。
- **二维码**：与地址严格同源——地址变了二维码立即重建。
- **状态与错误可见**：端口被占用、没有可用网卡、地址不可用，都会在面板上写明原因，并给出「重新检测」。
- **WebSocket 与事件流通行**：DSH 的实时通道（`/api/remote.mux`）与 SSE 事件流都能穿过网关；事件流在静默时补注释帧，避免被链路空闲回收。
- **透明的 DSH 认证**：转发时按 DSH 的格式现签一枚回环会话 cookie，并改写 Host / Origin / Referer。手机上看到的仍然是 DSH 自己的登录页，插件不引入第二套密码体系。

## 安装

```bash
# 从本地目录安装（推荐，用于二次开发）
dsh plugin --profile desktop add /path/to/dsh-remote

# 或用插件面板：设置 → 插件 → 添加插件 → 选择本目录
```

安装后在 **设置 → 局域网访问** 中查看。

## 在手机上「添加工作区」

桌面版把监听地址写死为 `127.0.0.1`，而 DSH 的目录选择器按启动时的宿主情况二选一
（`@deepseek-ai/dsh-host-directory-picker-auto`）：

- 绑定回环、且没有 `--trusted-host` → **native**：在电脑显示器上弹系统对话框；
- 其余情况 → **browse**：在网页里打开「选择工作区目录」，可新建文件夹。

桌面版恒为回环，所以默认永远是 native —— 手机点了「添加工作区」后，对话框开在电脑屏幕上，
手机端看起来「没反应」。**这不是插件的问题，也不需要写任何代码**：DSH 官方文档
（`dsh-host-directory-picker`「Choosing a backend」）给出的受支持做法是「固定某个交互 =
直接组合那一对包」。

在 profile 的 patch 里把自适应选择器换成 browse 即可（`~/.dsh/profiles/<profile>/cordis.patch.yml`，
Windows 为 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）：

```yaml
# 关掉自适应：它在回环绑定下永远选 native
- id: directory-picker
  name: "@deepseek-ai/dsh-host-directory-picker-auto"
  disabled: true

# 直接组合 browse：宿主能力 + 客户端界面各一行
- insert:
    - id: directory-picker-browse
      name: "@deepseek-ai/dsh-host-directory-picker-browse"
    - id: directory-picker-browse-ui
      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"
```

重启 DSH 生效。之后桌面端与手机端都会使用同一个网页内目录浏览器：

1. 侧边栏「添加工作区」→ 弹出「选择工作区目录」；
2. 「新建文件夹」→ 单元格名字 → 目录会**真实创建在宿主机上**；
3. 选中后点「打开」→ 该目录注册为 Workspace，可直接新建会话。

若想恢复官方自适应行为，删掉这三段即可。

## 端口

局域网入口固定为 **3080**，理由：

1. 3080 是 DSH 的默认端口，用户不需要记两个数字；
2. 桌面版实际监听的是随机端口（本机为 `127.0.0.1:64190`），3080 因此完全空闲；
3. 即使有程序占用了 `127.0.0.1:3080`，网关绑的是局域网地址，两者在同一台机器上可以共存（已在 macOS 实测）。

端口只有一个来源：`lib/config.js` 的 `LAN_PORT`。`npm run lint` 会扫描整个仓库，确认没有第二个端口字面量、没有旧端口残留，并交叉校验客户端副本。

如果 3080 被别的程序占在**同一个地址**上，网关会启动失败并在面板上说明原因——不会偷偷换端口，也不会去结束占用进程。

## 它不做什么

这一版刻意只保留局域网能力，没有：

- Cloudflare 公网隧道 / 自建隧道 / 公网域名管理
- 微信 / QQ / 飞书 / Telegram 机器人
- 插件自建的访问密码、Token、白名单、授权码
- 运维看板、备份导入导出、一键重启

DSH 原生的登录与权限机制保持原样，没有改动。

## 开发

```bash
npm run build   # 重新打包 client/client.js
npm test        # 单元 + 端到端测试（会真的起监听验证代理与 WebSocket）
npm run lint    # 端口口径检查
```

目录：

```
lib/             Host 半边
  config.js      端口与 RPC 常量（唯一来源）
  lan.js         网卡探测与选择
  gateway.js     局域网监听 + 反向代理（HTTP / WebSocket / SSE）
  dsh-cookie.js  DSH 原生会话 cookie 兼容层
  qr.js          二维码生成与缓存
  service.js     状态聚合与生命周期
  rpc.js         面板接口
client/          浏览器半边
  panel.js       设置页面板
  locales.js     中英文案
scripts/         构建与检查脚本
tests/           测试
```

## 许可

MIT
