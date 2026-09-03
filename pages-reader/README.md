# GitHub Pages 阅读版

这是只读静态站点：加载已经导出的 EPUB/TXT 和双语替换结果，保留目录、章节跳转、分区滚动与点击中英文切换；没有 AI 生成、API 设置或后端请求。

## 更新内容

1. 在本地完整版中继续生成章节。
2. 点击左侧“更新 GitHub Pages 阅读版”，再点“预览阅读版”检查。
3. 在项目目录提交并推送：`git add pages-reader/public/library && git commit -m "Update published reading content" && git push`。
4. `.github/workflows/pages.yml` 会自动构建并更新 Pages。

首次使用时，在 GitHub 仓库的 **Settings → Pages → Source** 选择 **GitHub Actions**。项目站点地址通常是 `https://<用户名>.github.io/<仓库名>/`。

## 内容权利

Pages 会把原书文件交付给网站访问者。只有在你拥有该书网络传播权或获得明确授权时，才应把包含原书的仓库与站点公开。个人自用可保留在本机，或改用你能合法公开的内容测试部署。
