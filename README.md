# 豆豆的画板 · 儿童画画（PWA 部署包）

这是一个可直接上传到 Cloudflare Pages 的静态网站包。保留了原有画板功能，并增加了安卓安装和离线启动能力。

## 文件结构

```text
kids-drawing-pwa/
├── index.html                 # 原画板（已加入 PWA 引用和离线注册）
├── manifest.webmanifest       # 应用名称、主题色、启动方式和图标声明
├── service-worker.js          # 首次访问后缓存应用，离线时可打开
└── icons/
    ├── icon-192.png           # 安卓桌面图标
    ├── icon-512.png           # 高清桌面图标
    └── icon.svg               # 浏览器标签页图标源文件
```

## 部署到 Cloudflare Pages

1. 登录 Cloudflare，进入 **Workers & Pages**。
2. 选择 **Create application → Pages → Upload assets**。
3. 上传此文件夹内的全部文件，保持目录结构不变。
4. 输入项目名称，例如 `kids-drawing`，然后部署。
5. 用安卓 Chrome 打开部署后的 `https://你的项目.pages.dev/` 地址。

Cloudflare Pages 默认提供 HTTPS；PWA 的安装和 Service Worker 缓存需要 HTTPS（本机 `localhost` 测试也可以）。

## 在安卓 Chrome 安装

1. 用 Chrome 首次打开网站，并等待页面完全加载一次。
2. 点右上角 **⋮**。
3. 选择 **安装应用**；如果没有该项，选择 **添加到主屏幕**。
4. 确认后，桌面会出现“豆豆的画板”图标。

安装后从桌面图标启动，会以独立应用窗口打开。首次打开完成缓存后，断网也能进入画板；新版本上线后，下次联网打开会自动更新缓存。

## 注意

- 作品使用浏览器 `localStorage` 保存在本机；清除 Chrome 的网站数据会清空未导出的作品。
- 用画板内的保存按钮可把完成的作品导出为 PNG，建议定期保存到相册。
