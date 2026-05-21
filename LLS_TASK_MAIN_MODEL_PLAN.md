# LLS CCAI 任务流重构方案：由主模型创建任务流

## 背景

当前 `@llsccai-task` 任务流使用独立的任务流 Provider/Model 来分析用户提示或规划文档，并生成 workflow JSON。实际联调中发现：

1. Claude Code 发送的 IDE 打开文件信息不是纯文件路径，而是带有 `<ide_opened_file>...</ide_opened_file>` 等上下文说明。
2. 用户启动任务流时，当前 Claude Code 主模型已经能看到打开文件、用户提示、工具能力等上下文。
3. 因此不需要再单独配置“任务流模型”。
4. 更合理的方式是：
   - 没有未完成任务流时，Relay 只注入“创建任务流”的 system 提示和工具；
   - 由当前主模型根据用户提示或打开的文档调用工具创建任务流；
   - 创建后扩展在本地保存 workflow，并进入后续自动续推/状态回写流程。

## 目标

- 移除对独立任务流 Provider/Model 的强依赖。
- 当当前没有未完成任务流时，不提前调用额外模型生成 workflow。
- 通过 Anthropic tool 让当前主模型创建任务流。
- 任务流创建与任务状态更新都在 Relay 本地拦截执行，不依赖 Claude Code 真正处理工具结果。
- 保留已有自动续推、状态栏、任务状态更新能力。

## 总体流程

### 1. 无未完成任务流时

当 Relay 收到 `/v1/messages` 请求：

1. 检测最后一条 user 消息是否包含 `@llsccai-task`。
2. 如果当前没有 active workflow：
   - 不调用独立任务流模型；
   - 不直接返回“正在分析”；
   - 转发请求到上游主模型；
   - 在请求中注入：
     - 创建任务流 system rule；
     - `create_llsccai_task_workflow` 工具。
3. 主模型根据：
   - 用户在 `@llsccai-task` 后输入的提示；
   - Claude Code 自动注入的 `<ide_opened_file>` 上下文；
   - 已打开文档内容或后续读取文件工具结果；
   调用 `create_llsccai_task_workflow` 创建 workflow。
4. Relay 拦截该工具调用，在本地保存 workflow。
5. Relay 将工具调用改写为普通 text 响应，避免 Claude Code 报工具解析或等待 tool_result。
6. 创建成功后，如果 workflow 未完成，则调度自动续推。

### 2. 有未完成任务流时

当已有 active workflow：

1. Relay 继续注入：
   - 当前 workflow 的 system rule；
   - `update_llsccai_task_workflow` 工具。
2. Relay 不注入 `create_llsccai_task_workflow` 工具，避免主模型在已有未完成任务流时重复创建或覆盖 workflow。
3. 主模型执行实际任务。
4. 当任务状态变化时，主模型调用 `update_llsccai_task_workflow`。
5. Relay 本地更新任务状态。
6. 如果 workflow 仍未完成，继续自动续推；完成则停止。

## 工具设计

### create_llsccai_task_workflow

用于首次创建任务流。

```json
{
  "name": "create_llsccai_task_workflow",
  "description": "Create an LLS CCAI task workflow from the user's prompt, currently opened planning document, or gathered context.",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["workflow"],
    "properties": {
      "workflow": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "summary", "tasks"],
        "properties": {
          "title": {
            "type": "string",
            "description": "Workflow title."
          },
          "summary": {
            "type": "string",
            "description": "Short workflow summary."
          },
          "tasks": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["id", "title", "description", "status"],
              "properties": {
                "id": {
                  "type": "string",
                  "description": "Stable task id, usually sequential numbers as strings."
                },
                "title": {
                  "type": "string",
                  "description": "Short task title."
                },
                "description": {
                  "type": "string",
                  "description": "Detailed task description."
                },
                "status": {
                  "type": "string",
                  "enum": ["pending", "in_progress", "completed", "blocked"],
                  "description": "Initial task status. Usually pending."
                }
              }
            }
          }
        }
      }
    }
  }
}
```

### update_llsccai_task_workflow

保留现有工具，用于更新任务状态。

```json
{
  "name": "update_llsccai_task_workflow",
  "description": "Update statuses of tasks in the active LLS CCAI workflow.",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["updates"],
    "properties": {
      "updates": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["taskId", "status"],
          "properties": {
            "taskId": {
              "type": "string"
            },
            "status": {
              "type": "string",
              "enum": ["pending", "in_progress", "completed", "blocked"]
            }
          }
        }
      }
    }
  }
}
```

## System Rule 设计

### 无 active workflow 时

当用户触发 `@llsccai-task` 且当前没有未完成 workflow，注入如下规则：

```text
The user wants to start an LLS CCAI task workflow.

You must create a workflow by calling create_llsccai_task_workflow after you understand the user's task.

Workflow creation rules:
- Use the user's prompt after @llsccai-task as the primary requirement.
- If the prompt is only the default placeholder, inspect the IDE-opened file context such as <ide_opened_file>.
- If an opened Markdown planning document is available, read or use that document as the planning source.
- If neither a useful prompt nor an opened planning document is available, ask the user to open a Markdown planning document or edit the prompt.
- The workflow must contain clear, executable tasks.
- Task ids must be stable strings, usually "1", "2", "3".
- Initial statuses should usually be pending, unless a task has already been completed in the current turn.
- Do not create a workflow unrelated to the user's request.
- Call create_llsccai_task_workflow in a separate tool-call round; do not mix it with ordinary file edits or terminal commands.
```

### 有 active workflow 时

沿用当前规则，但只注入更新工具，绝不注入创建工具：

```text
Active llsccai-task workflow is available for the current workspace.

Workflow tool usage rules:
- Use this workflow as execution guidance when the user request is related to the current work.
- When actual task progress changes, call update_llsccai_task_workflow.
- You may only update task statuses: pending, in_progress, completed, blocked.
- You may NOT modify task titles, descriptions, order, or summary.
- Do not call the workflow update tool unless the status actually changed.
```

## Relay 行为调整

### 当前行为

当前触发 `@llsccai-task` 后：

1. Router 截获请求；
2. 调用 `LlsTaskService.handleRelayTrigger()`；
3. 使用独立任务流模型生成 workflow；
4. 直接返回 Anthropic text response；
5. 再粘贴 continue prompt。

### 新行为

新行为应调整为：

1. Router 只负责识别触发状态，不再调用独立任务流模型。
2. 如果没有 active workflow 且触发了 `@llsccai-task`：
   - 标记本次请求需要注入创建任务流工具；
   - 继续走正常上游转发。
3. Anthropic Proxy 根据状态注入：
   - `create_llsccai_task_workflow`；
   - 创建任务流 system rule。
  - 仅在当前没有 active workflow 且本轮触发 `@llsccai-task` 时注入。
4. Interceptor 拦截 `create_llsccai_task_workflow`：
   - 校验 workflow JSON；
   - 保存到 `LlsTaskService`；
   - 改写响应为 text；
   - 调度自动续推。

## 服务层调整

### LlsTaskService

建议保留：

- `getSnapshot()`
- `hasActiveWorkflow()`
- `isWorkflowCompleted()`
- `clear()`
- `buildContinuePrompt()`
- `updateTaskStatuses()`
- `onDidChange`

新增：

- `createWorkflow(workflow: LlsTaskWorkflow): LlsTaskUpdateResult`
  - 校验并规范化 workflow；
  - 保存到 snapshot；
  - 发出 onDidChange。

可废弃或保留兼容：

- `generateWorkflow(planningText)`
- `requestModel(...)`
- `parseWorkflowResponse(...)`
- `handleRelayTrigger(...)`

如果彻底移除独立模型，后续 UI 中的 `llsTask.providerId/modelId` 配置也可以隐藏或废弃。

## 状态栏调整

当前状态栏存在“缺少任务流模型”的状态。新方案下不再需要任务流模型，因此状态栏应改为：

1. 无 workflow：显示可启动任务流。
2. 有 workflow 且进行中：显示进度。
3. workflow 已完成：显示完成状态，可清空并新建。

移除或忽略：

- missingModel 文案；
- provider/model 配置依赖；
- provider/model 配置变更刷新逻辑。

## 请求过滤调整

之前为避免提示词污染，Relay 会过滤输入框中粘贴的任务流控制提示。新方案仍需要保留过滤，但规则要区分两类：

1. 创建阶段：
   - 不应该过滤用户的 `@llsccai-task` 原始请求，因为主模型需要根据它判断是否创建 workflow。
   - 但可以过滤纯默认占位提示中的无意义模板文本，避免模型回答模板本身。
2. 续推阶段：
   - 继续过滤 `Active llsccai-task workflow...`、`Workflow JSON:`、`Workflow usage rules:` 等内部控制提示。

## 自动续推调整

创建 workflow 成功后：

1. 如果 workflow 未完成，立即或延迟调度自动续推。
2. 自动续推粘贴的内容仍可保留简短提示，例如：

```text
Continue executing the active llsccai-task workflow.
```

3. 上游真正需要的 workflow JSON 不应从 user message 传入，而应通过 system rule 注入。

## 兼容性策略

建议分两阶段实施。

### 阶段一：兼容改造

- 保留现有独立任务流模型代码，但不再默认使用。
- 新增 `create_llsccai_task_workflow` 工具。
- Router 触发后改为转发上游，并仅在没有 active workflow 时注入创建工具。
- 有 active workflow 时不注入创建工具，只注入 `update_llsccai_task_workflow`。
- Interceptor 支持创建工具。
- 状态栏暂时保留旧配置项但不强依赖。

### 阶段二：清理旧逻辑

- 移除任务流 Provider/Model 配置依赖。
- 删除或废弃 `generateWorkflow/requestModel`。
- 清理 missingModel 相关文案和 UI。
- 更新文档和 README。

## 验收标准

1. 未配置任务流 Provider/Model 时，仍可启动 `@llsccai-task`。
2. 用户打开 Markdown 方案文档并发送默认启动提示时，主模型能读取/理解文档并调用创建工具生成 workflow。
3. 用户直接在 `@llsccai-task` 后写需求时，主模型能基于该需求创建 workflow。
4. 没有打开文档且提示词仍是默认占位时，模型应提示用户打开 Markdown 文档或修改提示词，而不是生成无关 workflow。
5. workflow 创建后，状态栏显示进度。
6. 后续任务状态可通过 `update_llsccai_task_workflow` 本地回写。
7. 自动续推不会把内部 Workflow JSON 当成用户真实需求转发给上游。
8. `npm run typecheck && npm run compile` 通过。
