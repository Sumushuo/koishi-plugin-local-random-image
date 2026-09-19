# koishi-plugin-local-random-image

一个基于 Koishi 框架的本地图库关键词触发插件。

## 功能特性

1. **关键词直接触发**：用户发送与本地图库中某个文件夹名字相同的消息时，Bot 自动从该文件夹中随机挑一张图片发送。
2. **静默不干扰**：如果用户发送的关键词不存在对应的本地文件夹，Bot **不做任何响应**，完全不干扰正常聊天与其他指令。
3. **安全防护**：内置路径穿越（Path Traversal）安全拦截，严防利用 `../`、路径分隔符访问系统敏感目录。
4. **跨平台兼容**：自动处理 Windows 与 Linux 路径，使用标准的 `file://` 协议传递本地图片资源。
5. **支持大小写不敏感匹配**（可配置开关）。
6. **防刷屏 CD（冷却时间）支持**（可配置）。

---

## 本地图库组织示例

假设你在配置中设置图库根目录为 `D:/Images`：

```text
D:/Images/
├── 猫猫/
│   ├── 01.jpg
│   ├── 02.png
│   └── 03.webp
├── 柴犬/
│   ├── 01.jpg
│   └── 02.gif
└── 早安/
    └── 1.png
```

- 群里用户发送：`猫猫` -> 从 `D:/Images/猫猫/` 随机发送一张图片。
- 群里用户发送：`今天天气真好` -> 本地没有对应名字的文件夹，**静默忽略**，交给后续插件或不回复。

---

## 安装与使用方式

### 方式 A：作为本地插件加载（推荐）
1. 在本目录安装依赖并构建（若使用 TS 源码）：
   ```bash
   npm install
   npm run build
   ```
2. 在你的 Koishi 项目中引入：
   - 可以通过 `npm link` 软链接到 Koishi 的 `node_modules`。
   - 或者直接在 Koishi 项目的 `package.json` 的 `dependencies` 里填入相对/绝对路径：
     ```json
     "koishi-plugin-local-random-image": "file:你的插件目录/koishi-plugin-local-random-image"
     ```
3. 打开 Koishi Web 控制台，进入「插件配置」启用本插件，填写你的图库根目录 `baseDir` 即可。

### 方式 B：直接单文件引入
如果不想编译 TypeScript，直接使用根目录下的 `index.js` 即可，它是标准的 CommonJS 模块。
