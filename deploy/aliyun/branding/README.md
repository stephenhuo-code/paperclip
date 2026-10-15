# 登录页 logo

放一个 logo 文件到本目录（推荐 `logo.png` 或 `logo.svg`：横版、透明背景、高度不小于 64px），
并在 `environments/<env>.env` 中设置：

```
PAPERCLIP_BRAND_NAME=FiveGuys 数字员工平台
PAPERCLIP_BRAND_LOGO_URL=https://<APP_DOMAIN>/brand/logo.png
```

Caddy 在 `https://<APP_DOMAIN>/brand/` 下提供本目录；Paperclip 登录页和 Keycloak 登录页都引用这个地址。
不设置 `PAPERCLIP_BRAND_LOGO_URL` 时只显示名称；两项都不设置时保持 Paperclip 原样。
