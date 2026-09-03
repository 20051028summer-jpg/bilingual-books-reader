# GitHub Pages 阅读版

这是只读静态站点：加载已经导出的 EPUB/TXT 和双语替换结果，保留可折叠目录、章节跳转、分区滚动、点击中英文切换，以及跨章节双语词搜索；没有 AI 生成、API 设置或后端请求。

搜索完全在浏览器中运行，范围是 `manifest.json` 里已经发布的替换记录。可输入英文或对应中文，结果会显示章节和原段落上下文，并可点击跳回正文。尚未生成双语内容的章节不进入词搜索范围。

## 更新内容

1. 在本地完整版中继续生成章节。
2. 点击左侧“更新 GitHub Pages 阅读版”，再点“预览阅读版”检查。
3. 在项目目录运行 `git status` 检查改动，然后执行：`git add pages-reader/public/library && git commit -m "Update published reading content" && git push`。
4. `.github/workflows/pages.yml` 会在 push 后自动运行并更新 Pages；正常情况下不需要再手动点击 **Run workflow**。只有自动运行失败、被取消，或你想在没有新提交时重建，才手动运行或点击 **Re-run jobs**。

首次使用时，在 GitHub 仓库的 **Settings → Pages → Source** 选择 **GitHub Actions**。项目站点地址通常是 `https://<用户名>.github.io/<仓库名>/`。

## 内容权利

Pages 会把原书文件交付给网站访问者。只有在你拥有该书网络传播权或获得明确授权时，才应把包含原书的仓库与站点公开。个人自用可保留在本机，或改用你能合法公开的内容测试部署。
