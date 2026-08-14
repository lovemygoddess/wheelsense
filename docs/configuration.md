# 配置说明

## 必填项

| 配置 | 用途 |
| --- | --- |
| `APP_KEY` | Laravel 加密密钥，用 `php artisan key:generate` 生成 |
| `BMS_RELAY_TOKEN` | 中继 Bearer 身份凭证 |
| `BMS_RELAY_HMAC_SECRET` | 中继请求体签名密钥 |
| 仪表盘密码 | 用 `php artisan evtelemetry:set-dashboard-password` 设置 |

Token 和 HMAC 必须成对轮换。可先填写 `*_NEXT` 容忍新旧中继，完成升级后立即删除旧对。

## 中继远控

`ENABLE_RELAY_REMOTE_CONTROL=false` 时，服务端拒绝所有中继指令，包括拍照、截图和固件更新。即使开启远控，`ENABLE_DANGEROUS_RELAY_COMMANDS=false` 仍会额外拒绝重启、关机、模拟按键/滑动、清队列与自更新等高风险命令。只能对自己拥有或获得明确授权的设备开启。

## NineCLI 兼容桥接

`NINECLI_BASE_URL` 指向一个提供本项目预期 REST 接口的独立服务。该组件不包含在本仓库，也不是 Ninebot 官方 API。不配置时请把仪表盘视为 BMS 为主的离线仪表。

## TPMS

前后轮传感器 MAC 分别填入 `TPMS_FRONT_MAC` 和 `TPMS_REAR_MAC`。胎温按 `T = slope × byte1 + intercept` 解码，默认参数只是通用起点，必须用可信温度计做自身设备标定。

## APK 更新文件

- 中继：`storage/app/bms-relay-latest.apk`
- 仪表盘：`storage/app/dashboard-latest.apk`

Docker 部署对应主机目录为 `data/storage/app/`。应用覆盖安装必须保持 application ID 和签名证书不变，版本号必须递增。

## 运行注意

当前代码有少量安全参数为运行时 `env()` 读取，不要执行 `php artisan config:cache`。可以使用 `route:cache` 和 `view:cache`。
