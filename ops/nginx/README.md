# 网站静态交付配置

`bem2075-site.conf` 为当前域名虚拟主机，`bem2075-upstream.conf` 放在 nginx 的 `http` 配置作用域。需要 HTTP/2 和 gzip_static 模块；生产 Nginx 1.24 使用 `listen ... ssl http2` 语法。

部署顺序：

1. 执行 `pnpm run build`。构建会为 JS/CSS/SVG 生成 `.gz`，原文件始终保留。
2. 将 `dist/assets/` 中的文件同步到 `/var/www/bem2075-static/assets/`，先放资源、后原子替换 HTML。保留旧哈希文件，供已打开的页面读取。静态目录只放公开构建文件，不指向存放运行凭据的目录。
3. 备份并安装两个配置，保留现有独立 API/RPC/login 限流配置。主配置 `events` 中使用 `worker_connections 4096`，文件描述符上限须足够；这不是在线人数指标。
4. 先运行 `nginx -t`，通过后 reload，再核验 gzip 解压后的字节、缓存头、HTTP/2、旧资源和应用健康。后端代码变化独立重启前台服务；不要重复启动索引或 keeper。

完整采样、接口减负及扩容边界见 [性能记录](../../docs/site-performance.md)。
