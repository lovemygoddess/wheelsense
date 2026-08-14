# Contributing

欢迎 Issue 和 Pull Request。请先描述设备型号、Android 版本、BMS 协议版本和可复现步骤，同时删除序列号、MAC、地址、位置和凭证。

提交前请至少运行：

```bash
cd server && php artisan test
cd ../apps/dashboard && npm ci --legacy-peer-deps && npx tsc --noEmit
cd ../relay && ./gradlew test assembleDebug
```

修改遥测计算逻辑时，请附单元测试、数据源新鲜度约束、单位和降级行为。修改 BMS/TPMS 解码时，不要仅根据注释猜测未知字段，需要抓包与可信真值交叉验证。
