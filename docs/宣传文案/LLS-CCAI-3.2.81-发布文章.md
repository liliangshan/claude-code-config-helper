# LLS CCAI 3.2.81更新：快速安装更新CLI，左右独立会话并行开发，内置图片MCP，你提需求，模型写提示词生成图标、插画和封面，让代码与创意在VS Code工作区连贯完成

用 AI 做开发，最怕的不是任务多，而是刚进入状态，就被各种切换打断。

想用 Claude Code，先去查 CLI 怎么安装；主任务做到一半，遇到报错，又得纠结要不要另开一段对话；项目需要一枚图标、一张插画，还要打开生图网站，重新解释需求、琢磨提示词，再把图片下载回来。

这些事单独看都不大，放在一起，却很容易把开发节奏切碎。

这次，**LLS CCAI（Claude Code Config Helper）3.2.81** 把三个常用能力放进了 VS Code：**CLI 快速安装更新、左右并行任务、内置图片 MCP。**

目标很简单：少折腾环境，少切换工具，让开发接着往下走。

## 安装和更新 CLI，可以简单一点

有些工具很好用，但第一次配置就让人望而却步。找安装命令、确认版本、设置路径，再回编辑器检查有没有配对，一套下来，真正的工作还没开始。

现在，LLS CCAI 提供了内置安装引导。打开扩展后，可以直接选择来源、下载并校验 CLI，再完成模型配置。已经装过 Claude CLI，也可以选择现有可执行文件，继续使用原来的环境，不必重新下载。

日常更新同样有入口：在设置里点击检查更新，确认后下载和安装，进度就在界面中显示。支持官方 npm，也可以按需要选择 npmmirror 镜像。

它不会强行覆盖你在外部安装的 CLI，托管更新也会保留旧版本文件。

**不用先研究一套安装流程，再开始使用工具。把环境配好这件事，尽量留在 VS Code 里完成。**

## 两个任务，左右各有位置

实际开发很少只有一条线。

你可能正在写页面，又需要分析接口报错；正在做功能实现，又想补一份测试清单。全塞进同一段对话，主线很容易被临时问题打散；不断切新窗口，又会增加操作负担。

LLS CCAI 的做法是：**主聊天和并行会话，左右各放一个。**

点击「并行会话」，直接打开另一侧聊天。两个会话各自保留上下文、模型选择和权限设置，中间的编辑区继续留给代码。

可以这样分工：

- **右侧写功能，左侧查报错**：让主任务继续推进，临时排查不挤占主对话。
- **右侧做页面，左侧整理接口**：一边实现交互，一边把字段和调用方式说明白。
- **右侧改代码，左侧梳理测试**：实现和验证思路分别展开，需要时把结论带回主任务。

如果两类任务适合不同模型，也可以分别选择，不必每次都在一段对话里切来切去。

这里的并行，是两个独立会话同时推进，不是让多个代理自动分工。**你决定任务怎么拆，工具负责让它们各有上下文、各有位置。**

## 图片需求，不必再单独跑一套流程

这次另一个很实用的更新，是内置图片 MCP。

它不只是给文章配一张图。应用图标、页面插画、文章封面、背景图、功能介绍素材，都可以直接从聊天需求开始。

比如，你可以这样说：

> 给这个记账应用生成一枚简洁的图标，主色调跟当前界面一致，小尺寸下也要容易辨认。

也可以说：

> 为这篇介绍开发工具的文章做一张封面，画面干净一些，突出编程和效率的主题。

或者：

> 给首页生成一张暖色调插画，内容是夕阳下使用电脑的橘猫，风格跟页面整体搭配。

**你负责提出需求，聊天模型负责写提示词，再调用图片模型生成。**

不必先自己把需求整理成一段专业生图提示词，也不用把项目背景搬到另一个工具里重新讲一遍。聊天模型可以结合当前对话和项目上下文，组织画面描述，并按需求提交尺寸等参数。

需要使用的图片模型，可以从已有提供商中选择，也可以独立填写 Base URL、API Key 和模型 ID。配置一次，左右聊天区都能共用，无需额外安装一套图片 MCP 包。

任务提交后，图片在后台生成。你不需要一直追问「完成了吗」，也不用让模型反复查询任务状态。完成结果会自动回到发起任务的会话；如果这个会话还在忙，就等它空闲后送入，模型再根据原需求接着处理。

生成的图片和任务记录直接保存在当前工作区的 `.LLSOAI/openapi-image-generation/` 中。模型同时会收到工作区路径、图片相对路径、绝对路径和完整的文件 URI，方便继续使用这些已有文件。

**从“这个功能怎么写”，到“顺便给它做一枚图标”，可以在同一个工作区里接着完成。**

## 怎么开始使用？

### 第一步：安装扩展，配置 CLI 和模型

在 VS Code 扩展中查找 **Claude Code Config Helper**，或者通过「从 VSIX 安装」加载安装包。

安装完成后，点击 **VS Code 左侧工具栏中形似字母「A」的 LLS CCAI 图标**，打开扩展。如果当前环境还没有完成初始化，界面会进入安装引导：

1. 选择界面语言和 CLI 下载来源。
2. 下载 CLI，或选择已经安装的 CLI 并验证。
3. 添加模型提供商，填写自己的连接信息和密钥，选择聊天模型。
4. 完成工作区配置，打开聊天。

后续需要更新 CLI，直接到设置里检查更新即可。更新前先处理好正在运行的任务，因为切换 CLI 会重启扩展管理的活动会话。

### 第二步：把主任务和辅助任务分开

先在主聊天中提出要做的事情，比如：

> 帮我给这个项目增加一个数据统计页面，先看现有结构，再开始实现。

需要另一条工作线时，点击「并行会话」，在另一侧提出独立任务：

> 帮我梳理统计接口需要哪些字段，整理一份说明，先不要修改实现文件。

这样主任务和辅助任务可以同时推进，聊天内容也不容易混在一起。

两个会话使用的是同一个工作区，**并不会自动把文件隔离开**。建议按模块、目录或职责分工，避免两边同时修改同一个文件。

### 第三步：配置图片工具，直接说需求

点击聊天输入区中、任务流后面的「图片」入口，打开全局图片配置。

你可以选择：

- **已有提供商**：选择支持图片接口的提供商和模型。
- **独立配置**：填写图片服务的 Base URL、API Key 和模型 ID。

保存并启用后，就可以在聊天里提需求，例如：

> 为刚才的数据统计页面生成一张空状态插画，简洁一些，和当前界面配色一致。

或者：

> 给这个工具设计一枚有辨识度的图标，先根据项目功能整理画面思路，再写提示词生成。

接下来，模型负责组织提示词、提交生成请求。完成后自动收到结果，再根据你的要求继续处理。

这里无需事先填写固定的图片尺寸；模型会在每次工具调用时按需求提交。支持哪些尺寸、能否编辑已有图片，要看所选服务商和图片模型的能力。

## 把它放进真实工作里，会是什么样？

假设你正在做一个小型记账应用。

先用主聊天实现首页和数据展示；同时打开并行会话，整理表单校验规则或测试场景。主流程跑起来后，再告诉模型：给应用生成一枚图标，给空页面补一张插画，整体风格与界面一致。

你不需要为了每个步骤重新切一套工具，也不需要从头再讲项目是做什么的。

当然，生成结果是否符合预期，仍然需要你判断。喜欢哪种风格、哪张图适合项目、哪些地方要调整，决定权一直在你手里。

**工具能做的，是把安装、并行对话、图片生成这些原本分散的操作接起来，让你少花一点时间在搬运信息上。**

## 使用前，记住这几件事

- 模型服务和 API Key 需要自行准备，扩展不包含免费调用额度。
- 图片生成、图片编辑，以及收到完成通知后继续处理结果的聊天模型调用，都可能产生费用。
- 不是所有聊天模型都支持图片接口，配置时需要选择兼容的服务和模型；图片编辑使用的是服务商兼容的 JSON 方式，不保证适配所有接口。
- 图片文件保存在工作区，但 `file://` 链接能否在聊天里直接预览，取决于使用环境；文件路径仍可用于后续定位和处理。
- LLS CCAI 是独立项目，不是 Anthropic 或 Microsoft 官方扩展。

## 少一点切换，多一点连贯

这次更新没有把重点放在增加多少个按钮上，而是希望几件高频操作能更顺手：

**CLI 不必反复查命令，两个任务不必挤在一段对话里，图标和图片素材也不必再单独搬到另一个流程。**

如果你已经习惯在 VS Code 里和 AI 一起开发，可以试试 LLS CCAI 3.2.81：先把环境快速配好，再让主任务、辅助工作和图片需求围绕同一个项目展开。

**你提需求，模型写代码，也负责写提示词调用生图。**

- **扩展名称**：Claude Code Config Helper（LLS CCAI）
- **本次版本**：3.2.81
- **开源项目**：<https://github.com/liliangshan/claude-code-config-helper>

---

## English Version

### LLS CCAI 3.2.81: Easier CLI Setup, Parallel Conversations, and AI-Generated Icons and Images in VS Code

When you build with AI, the biggest interruption is not always a difficult task. Sometimes it is everything you have to switch between to get that task done.

You want to use Claude Code, so you look up how to install the CLI. Halfway through a feature, an error appears, and you have to decide whether to derail the main conversation or open another window. Then the project needs an icon or an illustration, which means opening an image-generation service, explaining the project again, writing a prompt, and downloading the result.

None of these steps is particularly difficult on its own. Together, they break your flow.

**LLS CCAI (Claude Code Config Helper) 3.2.81** brings three useful capabilities into VS Code: **quick CLI installation and updates, independent side-by-side conversations, and built-in image-generation MCP tools.**

The goal is simple: less setup, less switching, and more time moving your project forward.

### Installing and Updating the CLI Should Be Easier

A useful tool should not require a long setup session before you can try it. Finding installation commands, checking versions, configuring paths, and going back to the editor to see whether everything works can take the energy out of getting started.

LLS CCAI includes a setup wizard. Open the extension, choose a download source, download and verify the CLI, and configure your model provider. If you already have Claude CLI installed, select and verify the existing executable instead of downloading it again.

Updates have a clear place, too. Check for updates in settings, confirm the update, and follow its progress in the interface. You can use official npm or choose the optional npmmirror source when appropriate.

The installer does not overwrite an external CLI installation, and managed updates retain previous executable versions.

**Spend less time looking up installation steps and more time using the tool—all from the editor where you already work.**

### Give Two Tasks Their Own Space

Development rarely follows a single thread.

You might be building a page while investigating an API error, or implementing a feature while preparing test cases. Put everything into one conversation, and a quick side question can pull the main task off track. Keep opening new windows, and you introduce a different kind of overhead.

LLS CCAI gives the main chat and an independent parallel conversation their own sides of the workspace.

Click **Parallel session** to open the other chat. Each conversation keeps its own context, model selection, and permission settings, while the editor area stays available for code.

For example:

- **Build a feature on the right and investigate an error on the left.** Keep troubleshooting separate from the main development conversation.
- **Implement a page on the right and document its API on the left.** Work on the interface while clarifying fields and request formats.
- **Change code on the right and outline tests on the left.** Explore implementation and verification separately, then bring the conclusions together when needed.

You can also choose different models for the two conversations if the tasks call for different strengths.

This is independent conversation concurrency, not automatic multi-agent delegation. **You decide how to divide the work; the extension gives each conversation its own context and place to work.**

### Image Requests Can Stay in the Development Conversation

Another addition in this release is built-in image-generation MCP support.

It is not just for decorating an article. Application icons, page illustrations, cover images, backgrounds, and feature graphics can all start with a request in chat.

For example:

> Generate a simple icon for this budgeting app. Match the main color of the current interface and make it recognizable at small sizes.

Or:

> Create a cover image for this article about development tools. Keep the composition clean and emphasize programming and productivity.

Or:

> Generate a warm illustration for the homepage: an orange cat using a laptop at sunset, with a style that fits the page.

**You describe what you need. The chat model writes the image prompt and calls the image model.**

You do not have to turn your request into a polished image-generation prompt first, or move the project background into another service and explain it again. The chat model can use the conversation and available project context to organize the visual description and submit parameters such as image dimensions.

Select a compatible model from an existing provider, or configure the image service independently with its Base URL, API key, and model ID. The global image connection is shared by both chats, and no separate image MCP package needs to be installed.

Generation runs in the background. There is no need to keep asking whether it has finished or have the model repeatedly poll task status. Completion returns automatically to the conversation that submitted the request. If that conversation is still busy, delivery waits until it is idle, then lets the model continue from the result.

Images and task records are saved in the current workspace under `.LLSOAI/openapi-image-generation/`. The model receives the workspace path, relative image path, absolute path, and complete file URI so it can continue working with the files that already exist.

**Going from “build this feature” to “create an icon for it” no longer has to mean starting a separate workflow.**

### Getting Started

#### Step 1: Install the Extension and Configure Your CLI and Model

Search for **Claude Code Config Helper** in the VS Code Extensions view, or install a downloaded package with **Install from VSIX**.

After installation, click the **LLS CCAI icon shaped like the letter “A” in the left-hand VS Code Activity Bar**. If setup has not been completed in the current environment, the extension opens its setup wizard:

1. Choose the interface language and CLI download source.
2. Download the CLI, or select and verify an existing installation.
3. Add your model provider, enter your connection details and API key, and select a chat model.
4. Finish configuring the workspace and open chat.

For future CLI updates, use **Check for updates** in settings. Finish or pause active work before switching versions: the update restarts active CLI sessions managed by the extension and can interrupt running tasks.

#### Step 2: Separate the Main Task from Supporting Work

Start with a request in the main chat, such as:

> Add a statistics page to this project. Inspect the existing structure before implementing it.

When you need a second thread, click **Parallel session** and give the other conversation a separate task:

> Work out which fields the statistics API needs and write a short specification. Do not change the implementation files yet.

This keeps the main development task and supporting work moving without mixing every discussion into one conversation.

Both conversations use the same workspace. **Their file changes are not automatically isolated.** Divide work by module, directory, or responsibility, and avoid having both conversations edit the same file at the same time.

#### Step 3: Configure Image Tools and Describe What You Need

Click the **Image** chip immediately after **Task flow** in the chat composer to open the global image configuration.

Choose either:

- **Existing provider:** select a provider and model that support the image API.
- **Independent connection:** enter the image service's Base URL, API key, and model ID.

Save and enable the connection, then make a request in chat:

> Generate a simple empty-state illustration for the statistics page we just built. Match the colors of the current interface.

Or:

> Design a distinctive icon for this tool. Use the project's purpose to develop a visual concept, then write the prompt and generate the image.

The model handles prompt preparation and submits the generation request. Once completion is delivered automatically, it can continue according to your original request.

There is no fixed image-size field to configure in advance. The model submits dimensions for each tool call. Supported sizes and the ability to edit existing images depend on the selected provider and image model.

### What Does This Look Like in Practice?

Imagine you are building a small budgeting app.

Use the main conversation to implement the homepage and data display. Open the parallel conversation to organize form-validation rules or test scenarios. Once the core flow works, ask the model to generate an app icon and an empty-state illustration that fit the interface.

You do not have to switch to a different tool at every step or explain the purpose of the project from the beginning each time.

You still decide whether the result meets your needs. Which style you prefer, which image belongs in the project, and what needs another revision remain your choices.

**The extension connects setup, parallel conversations, and image generation so you spend less time moving information between tools.**

### A Few Things to Know Before You Start

- Bring your own model service and API key. The extension does not include free model credits.
- Image generation, editing, and the chat-model turn that processes a completion notification may incur charges.
- Not every chat model supports image APIs. Choose a compatible service and model. Editing uses a provider-compatible JSON request, not universal multipart support.
- Generated files stay in the workspace, but whether `file://` links display inline depends on the environment. Their paths remain available for locating and processing the files.
- LLS CCAI is an independent project, not an official Anthropic or Microsoft extension.

### Less Switching, More Continuity

This update is not about adding as many buttons as possible. It is about making a few frequent operations easier to keep together.

**Installing the CLI should not require another round of command searches. Two tasks should not have to compete for one conversation. Icons and image assets should not always require a separate workflow.**

If you already work with AI inside VS Code, try LLS CCAI 3.2.81: set up your environment, give the main and supporting tasks their own space, and keep image requests connected to the same project.

**You describe the goal. The model writes code—and prepares the prompts to generate the images you need.**

- **Extension:** Claude Code Config Helper (LLS CCAI)
- **Version:** 3.2.81
- **Open-source project:** <https://github.com/liliangshan/claude-code-config-helper>
