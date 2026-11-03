# 接龙之树 · 写作接龙网站

一棵完全二叉树形的写作接龙：每一棒写完后，下面开放两个空位供人接续（同一人也可以接两棒）。

- **网页**：纯静态，托管在 GitHub Pages
- **账号与数据**：存在 Supabase 免费 Postgres 数据库里，所有权限规则都由数据库函数强制执行
- 无需服务器，无需构建，全程免费

## 部署（约 10 分钟）

### 1. 建数据库（Supabase）

1. 在 [supabase.com](https://supabase.com) 注册并新建一个项目（Free 套餐即可，区域选离参与者近的）。
2. 左侧 **SQL Editor** → New query → 把本仓库 [`supabase/schema.sql`](supabase/schema.sql) 的全部内容粘进去 → **Run**。
3. 再新建一个查询，运行下面这行来创建管理员（把密码换成你自己的；**这一行不要提交到仓库**）：

   ```sql
   select relay_bootstrap_admin('admin', '你的管理员密码');
   ```

4. 打开 **Project Settings → API**（新版控制台叫 **API Keys** 和 **Data API**），记下：
   - **Project URL**，形如 `https://abcdefgh.supabase.co`
   - **anon public key**（以 `eyJ` 开头）或 **publishable key**（以 `sb_publishable_` 开头）

   ⚠️ 只用这把公开的 key，**不要**用 `service_role` / `secret` key。

### 2. 放到 GitHub

1. 新建一个 GitHub 仓库，把本项目全部文件推上去（默认分支名为 `main`）。
2. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
3. 填写数据库配置，二选一：
   - **方法 A（推荐，不用改代码）**：仓库 **Settings → Secrets and variables → Actions → Variables** 标签页，添加两个 *Repository variables*：
     `SUPABASE_URL` = 第 1 步的 Project URL，`SUPABASE_KEY` = 第 1 步的公开 key。
   - **方法 B**：直接编辑 `site/config.js`，填进去后提交。
4. 到 **Actions** 标签页，运行（或等待自动运行）“Deploy to GitHub Pages”。完成后网址是
   `https://<你的用户名>.github.io/<仓库名>/`。

用 `admin` 登录，就可以在“管理”页认证其他人了。

### 本地预览

```bash
cd site && python3 -m http.server 8000
# 打开 http://localhost:8000 （同样需要先填好 config.js）
```

## 规则

| 颜色 | 含义 | 谁能做什么 |
|---|---|---|
| 灰 | 未开放 | 不可进入 |
| 白 | 待认领 | 任何**已认证**账号可认领 |
| 黄 | 写作中 | 仅认领者可编辑标题和正文（Markdown），其他人可浏览 |
| 绿 | 已完成 | 永久锁定；两个子节点变白，开放下一棒 |
| 红 | 已终止 | 永久锁定；整个子树删除，此支结束 |

初始只有根节点是白的。树上每个已认领节点显示标题和 `@认领者`。

附加设计：认领者可**放弃认领**（退回白色、内容清空）；管理员可**强制释放**别人的黄节点；编辑时自动保存；每个节点可“从头读到这里”；管理员可认证/取消认证、重置密码、导出全部内容。

## 注意事项

- **安全**：网页里的 key 是公开的，这是正常的。三张表都开启了 RLS 且不对网页端开放，网页只能调用 `relay_*` 函数，认领、编辑、锁定等规则都在函数里检查，绕过网页直接调接口也无法越权。账号密码用 bcrypt 存储，与 Supabase 自带的 Auth 无关（所以用户名可以是中文，也不需要邮箱）。
- **免费项目会休眠**：Supabase 免费项目连续约一周无人访问会被暂停，到控制台点一下 Restore 即可恢复，数据不丢。
- **备份**：管理页“导出全部内容（JSON）”，或用 Supabase 控制台的备份功能。
- **升级数据库**：以后更新了 `schema.sql`，再完整运行一次即可，不会清空数据。
- **网络**：GitHub Pages 和 Supabase 在部分地区访问较慢，正式开始前最好让参与者先试着打开一次。
- **忘记管理员密码**：在 SQL Editor 再运行一次 `select relay_bootstrap_admin('admin', '新密码');`。

## 目录

```
site/                 网页（GitHub Pages 发布的就是这个文件夹）
  index.html
  config.js           Supabase 地址和公开 key
  app.js              树、编辑器、管理页
  md.js               Markdown 渲染（先转义 HTML，防脚本注入）
  style.css
supabase/schema.sql   数据库表、规则函数和权限
.github/workflows/pages.yml   自动部署到 GitHub Pages
```
