# 双人开发 Git 协作规范

本文档适用于两个人协作开发，并且当前仓库采用如下分支结构：

- `main`：稳定分支，可发布、可交付
- `dev`：集成分支，放准备进入下一版的代码
- `feat/*`：功能分支，一个需求一个分支
- `fix/*`：修复分支，一个问题一个分支

---

## 1. 总体原则

双人协作时，必须遵守下面 6 条原则：

1. 不直接在 `main` 上开发
2. 不长期直接在 `dev` 上写需求
3. 一个需求只在一个独立分支里完成
4. 功能合并顺序固定为：`feat/* -> dev -> main`
5. 每次开始开发前，先同步最新远端代码
6. 每次合并前，先把最新 `dev` 同步到自己的功能分支

---

## 2. 分支职责说明

### `main`

用途：

- 存放稳定代码
- 代表当前可交付版本
- 不允许直接写功能代码

要求：

- 只有当 `dev` 已验证稳定后，才允许合入 `main`

### `dev`

用途：

- 作为集成分支
- 用于汇总已经开发完成、准备联调/测试的功能

要求：

- 不作为日常长期开发分支使用
- 不直接在上面各自写需求

### `feat/*`

用途：

- 开发单个功能需求

命名示例：

- `feat/login-optimize`
- `feat/order-export`
- `feat/windows-start-script`

要求：

- 一个需求一个分支
- 做完后合回 `dev`
- 合并完成后删除

### `fix/*`

用途：

- 修复单个问题

命名示例：

- `fix/start-script-timeout`
- `fix/order-page-crash`

要求：

- 一个问题一个分支
- 修复完成后合回 `dev`

---

## 3. 最推荐的开发流程

标准流程如下：

1. 从最新 `dev` 拉取代码
2. 从 `dev` 创建自己的功能分支
3. 在自己的功能分支上开发
4. 开发过程中定期同步最新 `dev`
5. 功能完成后，合并回 `dev`
6. `dev` 验证通过后，再合并到 `main`

可记忆成一句话：

> 从 `dev` 拉分支开发，在自己分支提交，做完合回 `dev`，稳定后再进入 `main`。

---

## 4. 每个 Git 命令的详细使用规范

### 4.1 查看当前状态

```powershell
git status
```

含义：

- 查看当前工作区状态
- 告诉你当前在哪个分支
- 告诉你哪些文件被修改了
- 告诉你哪些文件已暂存
- 告诉你哪些文件还没有被 Git 跟踪

什么时候用：

- 开发前看一眼
- 提交前看一眼
- 合并冲突后看一眼
- 推送前看一眼

---

### 4.2 查看所有分支

```powershell
git branch -a
```

含义：

- `git branch`：查看分支
- `-a`：显示本地分支和远端分支

作用：

- 看自己当前有哪些本地分支
- 看远端有哪些分支
- 看当前分支前面的 `*` 标记

---

### 4.3 切换到已有分支

```powershell
git checkout dev
```

含义：

- `git checkout`：切换分支
- `dev`：目标分支名

作用：

- 把当前工作分支切换到 `dev`

常见用法：

- 切回 `dev`
- 切回 `main`
- 切回自己的功能分支

---

### 4.4 创建并切换到新分支

```powershell
git checkout -b feat/login-optimize
```

含义：

- `git checkout`：切换分支
- `-b`：新建分支
- `feat/login-optimize`：新分支名字

作用：

- 基于当前分支创建一个新分支
- 创建后立即切换过去

什么时候用：

- 每次开始一个新需求时

注意：

- 创建前先确保你当前在最新的 `dev`

---

### 4.5 获取远端最新信息

```powershell
git fetch origin
```

含义：

- `git fetch`：从远端下载最新提交和分支信息
- `origin`：默认远端仓库名字

作用：

- 更新本地对远端仓库的认知
- 不会直接改动你当前工作区代码

和 `pull` 的区别：

- `fetch`：只下载，不自动合并
- `pull`：下载后自动合并到当前分支

什么时候用：

- 想先看看远端有没有更新，但暂时不合并
- 合并前先同步远端信息

---

### 4.6 拉取远端最新代码

```powershell
git pull origin dev
```

含义：

- `git pull`：拉取并合并远端代码
- `origin`：远端仓库名
- `dev`：远端分支名

作用：

- 从远端 `origin/dev` 拉取最新提交
- 合并到你当前所在的本地分支

前提：

- 你当前通常应该在 `dev` 分支上执行

什么时候用：

- 每天开工第一步
- 合并前
- 切新分支前

---

### 4.7 查看未提交改动内容

```powershell
git diff
```

含义：

- `git diff`：查看当前工作区相对于暂存区/最近提交的差异

作用：

- 看自己到底改了什么
- 防止误提交无关代码

查看某个文件的差异：

```powershell
git diff start.ps1
```

含义：

- 只查看 `start.ps1` 这个文件的改动

---

### 4.8 将改动加入暂存区

```powershell
git add .
```

含义：

- `git add`：把改动加入暂存区
- `.`：表示当前目录及子目录下所有改动

作用：

- 告诉 Git，这些改动准备进入下一次提交

更精确的用法：

```powershell
git add start.ps1
```

含义：

- 只把 `start.ps1` 这个文件加入暂存区

什么时候用：

- 提交前

注意：

- `git add .` 会把新文件、修改文件一起加入
- 所以执行前最好先看一眼 `git status`

---

### 4.9 查看已暂存但未提交的内容

```powershell
git diff --cached
```

含义：

- `--cached`：查看“已经 add 但尚未 commit”的内容

作用：

- 提交前最终确认本次提交具体包含哪些代码

---

### 4.10 提交当前改动

```powershell
git commit -m "feat: add windows start script"
```

含义：

- `git commit`：创建一个提交
- `-m`：后面跟提交说明文字

作用：

- 把暂存区中的改动保存为一个提交点

提交说明建议格式：

- `feat: xxx` 新功能
- `fix: xxx` 修复问题
- `docs: xxx` 文档更新
- `refactor: xxx` 重构
- `chore: xxx` 杂项维护

不推荐写法：

- `修改`
- `更新`
- `改一下`

因为这些说明无法帮助后续回溯历史。

---

### 4.11 第一次推送功能分支到远端

```powershell
git push -u origin feat/login-optimize
```

含义：

- `git push`：把本地提交上传到远端
- `-u`：建立本地分支与远端分支的跟踪关系
- `origin`：远端仓库名
- `feat/login-optimize`：当前要推送的分支名

作用：

- 把本地功能分支推到远端
- 之后可以直接用 `git push` 和 `git pull`

什么时候用：

- 新分支第一次上传远端时

---

### 4.12 后续继续推送当前分支

```powershell
git push
```

含义：

- 把当前分支推送到已经绑定的远端分支

前提：

- 之前执行过 `git push -u origin 分支名`

---

### 4.13 将最新 `dev` 合并到自己的功能分支

第一步，更新远端信息：

```powershell
git fetch origin
```

第二步，切回 `dev`：

```powershell
git checkout dev
```

第三步，更新本地 `dev`：

```powershell
git pull origin dev
```

第四步，切回自己的功能分支：

```powershell
git checkout feat/login-optimize
```

第五步，把最新 `dev` 合进来：

```powershell
git merge dev
```

含义：

- `git merge dev`：把 `dev` 分支的历史合并到当前分支

作用：

- 在自己的功能分支上提前吸收最新集成代码
- 提前暴露冲突
- 不把冲突带到 `dev`

---

### 4.14 处理冲突后的继续操作

当 `git merge dev` 出现冲突时：

先查看状态：

```powershell
git status
```

含义：

- Git 会告诉你哪些文件发生冲突

然后手工编辑冲突文件。你会看到类似标记：

```text
<<<<<<< HEAD
当前分支代码
=======
被合并进来的代码
>>>>>>> dev
```

含义：

- `<<<<<<< HEAD` 到 `=======`：当前分支的内容
- `=======` 到 `>>>>>>> dev`：来自 `dev` 的内容

你需要：

- 根据业务逻辑手工整理最终代码
- 删除这些冲突标记

解决完后执行：

```powershell
git add .
git commit -m "merge: sync latest dev into feat/login-optimize"
```

含义：

- `git add .`：告诉 Git 冲突已经处理完
- `git commit -m ...`：提交这次合并及冲突解决结果

---

### 4.15 把功能分支合并回 `dev`

第一步，确认自己分支是干净状态：

```powershell
git status
```

第二步，切回 `dev`：

```powershell
git checkout dev
```

第三步，拉取最新远端 `dev`：

```powershell
git pull origin dev
```

第四步，合并功能分支：

```powershell
git merge feat/login-optimize
```

含义：

- 把 `feat/login-optimize` 的提交合并进当前分支 `dev`

第五步，推送远端：

```powershell
git push origin dev
```

含义：

- 把更新后的 `dev` 上传到远端

---

### 4.16 把 `dev` 合并到 `main`

当 `dev` 验证完成、准备发布时执行：

切到 `main`：

```powershell
git checkout main
```

拉取最新远端 `main`：

```powershell
git pull origin main
```

合并 `dev`：

```powershell
git merge dev
```

含义：

- 把 `dev` 中稳定的代码合并到 `main`

推送远端 `main`：

```powershell
git push origin main
```

含义：

- 发布最新稳定代码到远端

---

### 4.17 删除本地已完成分支

```powershell
git branch -d feat/login-optimize
```

含义：

- `git branch -d`：删除本地分支
- `-d`：安全删除，只有已经合并过才允许删除

作用：

- 清理本地无用分支，保持仓库整洁

如果 Git 提示该分支还未合并，但你非常确定不要了：

```powershell
git branch -D feat/login-optimize
```

含义：

- `-D`：强制删除

注意：

- 强制删除有风险，可能丢失未保留代码

---

### 4.18 删除远端已完成分支

```powershell
git push origin --delete feat/login-optimize
```

含义：

- 删除远端仓库中的 `feat/login-optimize` 分支

作用：

- 避免远端分支越来越乱

---

### 4.19 查看提交历史

```powershell
git log --oneline --graph --decorate --all
```

含义：

- `git log`：查看提交历史
- `--oneline`：每个提交只显示一行
- `--graph`：显示分支图形结构
- `--decorate`：显示提交对应的分支名、标签名
- `--all`：显示所有分支历史

作用：

- 看分支关系
- 看合并历史
- 看当前功能分支是从哪里分出来的

---

## 5. 新需求开始时的标准操作手册

每次开始一个新需求时，严格按下面执行：

```powershell
git checkout dev
git pull origin dev
git checkout -b feat/xxx
```

逐条解释：

- `git checkout dev`
  - 切到 `dev`
- `git pull origin dev`
  - 确保本地 `dev` 是远端最新版本
- `git checkout -b feat/xxx`
  - 基于最新 `dev` 新建一个功能分支

---

## 6. 开发中的标准提交手册

开发过程中，每完成一个小阶段，就提交一次：

```powershell
git status
git add .
git commit -m "feat: xxx"
git push -u origin feat/xxx
```

如果这个分支已经推送过一次，后面可以简化成：

```powershell
git status
git add .
git commit -m "feat: xxx"
git push
```

---

## 7. 开发中同步别人代码的标准手册

当同学已经更新了 `dev`，你要同步时执行：

```powershell
git fetch origin
git checkout dev
git pull origin dev
git checkout feat/xxx
git merge dev
```

目的：

- 先把最新的集成代码吸收到你自己的分支里
- 尽早解决冲突

---

## 8. 需求完成后合并到 `dev` 的标准手册

```powershell
git status
git checkout dev
git pull origin dev
git merge feat/xxx
git push origin dev
```

解释：

- `git status`
  - 先确认自己没有遗漏未提交改动
- `git checkout dev`
  - 切回集成分支
- `git pull origin dev`
  - 确保本地 `dev` 最新
- `git merge feat/xxx`
  - 把功能分支合入 `dev`
- `git push origin dev`
  - 把新的集成结果推到远端

---

## 9. 联调完成后发布到 `main` 的标准手册

```powershell
git checkout main
git pull origin main
git merge dev
git push origin main
```

解释：

- `git checkout main`
  - 切到稳定分支
- `git pull origin main`
  - 确保本地 `main` 是远端最新
- `git merge dev`
  - 把已经验证通过的 `dev` 合入 `main`
- `git push origin main`
  - 发布稳定版本

---

## 10. 功能完成后的清理操作

```powershell
git branch -d feat/xxx
git push origin --delete feat/xxx
```

解释：

- `git branch -d feat/xxx`
  - 删除本地分支
- `git push origin --delete feat/xxx`
  - 删除远端分支

目的：

- 保持本地和远端分支整洁

---

## 11. 常见错误操作与禁止事项

### 禁止事项 1：两个人都直接在 `dev` 上开发

原因：

- 彼此代码会互相污染
- 提交边界不清晰
- 冲突会集中爆发在 `dev`

### 禁止事项 2：直接在 `main` 上开发

原因：

- 会破坏稳定分支
- 增加发布风险

### 禁止事项 3：一个分支混多个需求

原因：

- 后续很难审查
- 很难回滚某一个需求
- 很容易把无关代码一起带进 `dev`

### 禁止事项 4：长期不同步 `dev`

原因：

- 后续一次性合并冲突会非常大

### 禁止事项 5：轻易使用强推

```powershell
git push --force
```

含义：

- 用本地历史强行覆盖远端历史

为什么危险：

- 可能把同学已经推送的历史覆盖掉
- 容易造成协作混乱

双人协作时，除非两个人明确同步并确认，否则不要使用。

---

## 12. 每天开工前检查清单

每天开始开发前，先做这 4 件事：

1. 查看当前状态
2. 切到 `dev`
3. 拉取最新 `dev`
4. 再新建自己的功能分支

命令如下：

```powershell
git status
git checkout dev
git pull origin dev
git checkout -b feat/xxx
```

---

## 13. 每次准备提交前检查清单

提交前确认下面几点：

- 当前分支是否正确
- 是否只包含本需求改动
- 是否误带了临时文件、本地配置文件
- 是否已经看过 `git diff` 或 `git status`

常用命令：

```powershell
git status
git diff
git add .
git diff --cached
git commit -m "feat: xxx"
```

---

## 14. 最简执行版流程

如果你们平时只想记一个最简版本，就记下面这套：

### 开始开发

```powershell
git checkout dev
git pull origin dev
git checkout -b feat/xxx
```

### 日常提交

```powershell
git status
git add .
git commit -m "feat: xxx"
git push -u origin feat/xxx
```

### 同步别人代码

```powershell
git fetch origin
git checkout dev
git pull origin dev
git checkout feat/xxx
git merge dev
```

### 合并到 `dev`

```powershell
git checkout dev
git pull origin dev
git merge feat/xxx
git push origin dev
```

### 发布到 `main`

```powershell
git checkout main
git pull origin main
git merge dev
git push origin main
```

### 删除分支

```powershell
git branch -d feat/xxx
git push origin --delete feat/xxx
```

---

## 15. 结论

双人协作里，最稳的模式不是“长期都在同一个 `dev` 上开发”，而是：

- `dev` 作为集成分支
- 每个需求从 `dev` 拉新分支
- 在自己的分支上开发、提交、同步
- 功能完成后合回 `dev`
- `dev` 稳定后再进入 `main`

这样做的好处是：

- 每个人的改动边界清楚
- 冲突更早暴露
- 回滚更容易
- 提交历史更干净
- 发布更可控

