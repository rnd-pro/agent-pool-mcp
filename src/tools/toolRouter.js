/**
 * @param {object} options
 * @param {Record<string, Function>} options.handlers
 * @param {(name: string, args: object) => object | null} options.guardToolCall
 * @param {() => string} options.getActiveTasks
 * @returns {(request: object) => Promise<object>}
 */
export function createToolRouter({ handlers, guardToolCall, getActiveTasks }) {
  const toolHandlers = {
    delegate_task: handlers.handleDelegateTask,
    delegate_task_readonly: handlers.handleDelegateReadonly,
    get_task_result: handlers.handleGetTaskResult,
    cancel_task: handlers.handleCancelTask,
    finish_task: handlers.handleFinishTask,
    list_tasks: handlers.handleListTasks,
    get_board_state: handlers.handleGetBoardState,
    consult_peer: handlers.handleConsultPeer,
    list_sessions: handlers.handleListSessions,
    list_skills: handlers.handleListSkills,
    get_skill_content: handlers.handleGetSkillContent,
    resolve_context: handlers.handleResolveContext,
    create_skill: handlers.handleCreateSkill,
    delete_skill: handlers.handleDeleteSkill,
    install_skill: handlers.handleInstallSkill,
    schedule_task: handlers.handleScheduleTask,
    list_schedules: handlers.handleListSchedules,
    cancel_schedule: handlers.handleCancelSchedule,
    get_scheduled_results: handlers.handleGetScheduledResults,
    get_usage_guide: handlers.handleGetUsageGuide,
    create_pipeline: handlers.handleCreatePipeline,
    run_pipeline: handlers.handleRunPipeline,
    list_pipelines: handlers.handleListPipelines,
    get_pipeline_status: handlers.handleGetPipelineStatus,
    cancel_pipeline: handlers.handleCancelPipeline,
    signal_step_complete: handlers.handleSignalStepComplete,
    bounce_back: handlers.handleBounceBack,
    create_group: handlers.handleCreateGroup,
    list_groups: handlers.handleListGroups,
    delegate_to_group: handlers.handleDelegateToGroup,
    send_message: handlers.handleSendMessage,
    get_messages: handlers.handleGetMessages,
    save_script: handlers.handleSaveScript,
    list_scripts: handlers.handleListScripts,
    track_files: handlers.handleTrackFiles,
    untrack_files: handlers.handleUntrackFiles,
    get_tracked_files: handlers.handleGetTrackedFiles,
    list_workflows: handlers.handleListWorkflows,
    search_by_tags: handlers.handleSearchByTags,
    get_workflow_content: handlers.handleGetWorkflowContent,
  };

  return async (request) => {
    const { name, arguments: args = {} } = request.params ?? {};
    const guardResponse = guardToolCall(name, args);
    if (guardResponse) return guardResponse;

    let handler = toolHandlers[name];
    if (!handler) {
      return appendActiveTasksFooter({
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      }, getActiveTasks);
    }

    let response;
    try {
      response = await handler(args);
    } catch (error) {
      response = {
        content: [{ type: 'text', text: `CLI provider error: ${error.message}` }],
        isError: true,
      };
    }

    return appendActiveTasksFooter(response, getActiveTasks);
  };
}

function appendActiveTasksFooter(response, getActiveTasks) {
  const footer = getActiveTasks();
  if (footer && response.content?.[0]?.text) {
    response.content[0].text += footer;
  }
  return response;
}
