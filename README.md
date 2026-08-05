# 一起看 Watch Together

和朋友同步看视频的双人观影网站（纯前端 + MQTT 实时同步）。

## 功能
- 4 位房间号：创建 / 加入 / 换房，分享链接即可加入
- 多源 CMS 搜索（4 源并行）+ B站 iframe 同步 / YouTube 嵌入 / 抖音解析
- HLS 播放（HLS.js）、倍速、音量、全屏、PiP
- 播放 / 暂停 / 拖拽 seek / 倍速 / 8s 自检 / seek-ack 握手同步
- 气泡式聊天 + emoji 浮动反应 + 在线成员
- OLED Dark / Cinema Red 双主题，移动端底部 4 Tab

## 使用
直接打开 index.html（或部署到任意静态托管 / GitHub Pages）即可。

## 部署
`ash
# 本仓库已启用 GitHub Pages（main 分支 / 根目录）
# 推送 main 后自动发布: https://1792833687.github.io/watch-together/
git push origin main
`

## 技术
- MQTT: broker.emqx.io (wss)
- 播放: HLS.js + <video> / B站官方 iframe + postMessage 同步
- 片源: 苹果 CMS v10 JSON API（多源并行 + CORS 代理 fallback）