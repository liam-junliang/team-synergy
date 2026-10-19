import { getLocale } from './i18n.ts';

// Translate stable service error codes, never arbitrary server/user-provided prose.
const chineseErrors: Record<string, string> = {
  intake_invalid: '请检查候选格式、代码指纹、项目关联与大小限制；可在本机运行 tsp intake validate 获取具体诊断。',
  intake_conflict: '批次、关联目标或请求标识与当前状态冲突。请重新读取批次，核对已完成项后重新审阅。',
  intake_forbidden: '当前项目权限不允许此接入操作；审阅与发布需要项目负责人或管理员权限。',
  intake_not_found: '当前项目中没有可访问的接入批次。',
};
const englishErrors: Record<string, string> = {
  unauthorized: 'Sign-in failed or your session has expired. Please sign in again.',
  auth_credentials_invalid: 'Incorrect account or password.',
  auth_token_invalid: 'Your session has expired. Please sign in again.',
  auth_user_disabled: 'This account is disabled.',
  auth_device_limit_reached: 'Device limit reached. Revoke an unused device and try again.',
  authorization_pending: 'This request is waiting for browser approval.',
  slow_down: 'Too many checks. Wait a moment before trying again.',
  expired_token: 'This authorization request has expired. Start sign-in again in your terminal.',
  access_denied: 'This authorization request was denied.',
  auth_password_invalid: 'The password does not meet the requirements.',
  password_change_required: 'Change your password to continue.',
  user_account_exists: 'This account already exists.',
  user_system_admin_protected: 'This system administrator account is protected.',
  user_deleted: 'Deleted accounts and accounts being closed cannot be restored.',
  settings_url_invalid: 'Enter an HTTPS URL without credentials, query parameters or fragments. HTTP is allowed only for loopback addresses. The Web URL must not include a path.',
  settings_input_invalid: 'Provide both public URLs and the current settings revision.',
  settings_revision_conflict: 'Settings have changed. Reload them before saving again.',
  settings_forbidden: 'Only system administrators can manage these settings.',
  admin_forbidden: 'Only active system administrators can access this console.',
  admin_input_invalid: 'Check the name, status and reason for this change.',
  admin_query_invalid: 'Check the search, filters and pagination parameters.',
  admin_revision_conflict: 'This project has changed. Close the editor, refresh the list and try again.',
  project_has_active_runs: 'This project has running or pending handover tasks. Complete the handovers or stop the runs before archiving it.',
  team_owner_removal_requires_demotion: 'Change this owner’s role before removing them.',
  project_archived: 'This project is archived and cannot be changed.',
  project_document_folder_system: 'System folders cannot be renamed, moved, deleted, or contain subfolders.',
  project_document_folder_read_only: 'This system folder is managed by its source workspace.',
  project_document_source_read_only: 'Edit this document through its source workspace.',
  project_home_standards_managed: 'Manage project standards in the Project standards folder.',
  architecture_document_revision_conflict: 'A newer diagram version exists. Reload it before saving your changes.',
  testing_revision_conflict: 'A newer test version exists. Reload it and merge your changes before saving.',
  testing_defect_conflict: 'This test result already has a linked defect. Reload the execution record.',
  testing_invalid: 'Check the test content, referenced versions, file details, and required execution fields.',
  intake_invalid: 'Check the candidate format, source fingerprints, project references and size limits. Run tsp intake validate for local diagnostics.',
  intake_conflict: 'The batch, target or request identifier conflicts with the current state. Reload the batch, check completed items and review the plan again.',
  intake_forbidden: 'Your current project permissions do not allow this intake action. Only project owners and admins can review and publish candidates.',
  intake_not_found: 'This intake batch is not available in the current project.',
  snapshot_conflict: 'This record has changed. Reload it and try again.',
  base_snapshot_conflict: 'This record has changed. Reload it and try again.',
  conflict: 'The request conflicts with the current state. Refresh and try again.',
  invalid_transition: 'This status change is not allowed from the current state.',
  transition_invalid: 'This status change is not allowed from the current state.',
  task_contract_locked: 'This task has started. Its contract can no longer be edited.',
  acceptance_required: 'Add acceptance criteria before continuing.',
  requirement_tasks_incomplete: 'Complete the linked tasks before continuing.',
  requirement_tasks_required: 'Link delivery tasks before continuing.',
  requirement_questions_unresolved: 'Resolve the open questions before continuing.',
  feature_schedule_outside_milestone: 'Feature dates must fall within the milestone dates.',
  milestone_feature_schedule_conflict: 'Milestone dates conflict with linked feature dates.',
  milestone_date_range_invalid: 'Check the milestone start and end dates.',
  fix_task_required: 'Link a fix task before continuing.',
  fix_task_not_completed: 'Complete the fix task before continuing.',
  design_prototype_file_too_large: 'The uploaded file exceeds the size limit.',
  design_prototype_url_invalid: 'Enter a valid HTTP or HTTPS URL.',
  design_prototype_file_required: 'Select a file to upload.',
  architecture_document_source_invalid: 'The diagram source is invalid. Check its syntax.',
  architecture_document_image_invalid: 'Choose a supported image file.',
  architecture_document_preview_invalid: 'The diagram preview is invalid.',
  handover_version_conflict: 'This handover has changed. Reload it before continuing.',
  handover_expired: 'This handover has expired.',
  handover_not_ready: 'This handover is not ready to be accepted.',
  handover_stop_required: 'Stop the active execution before handing over.',
  internal_error: 'The service encountered an error. Please try again.',
};

/** Preserve the original details for diagnostics while UI messages follow the current language. */
export class ApiError extends Error {
  readonly code: string;
  readonly originalMessage: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super();
    this.name = 'ApiError';
    this.code = code;
    this.originalMessage = message;
    this.status = status;
    Object.defineProperty(this, 'message', { configurable: true, get: () => {
      let displayed = getLocale() === 'zh-CN' && Object.hasOwn(chineseErrors, this.code) ? chineseErrors[this.code] : this.originalMessage;
      if (getLocale() === 'en-US') {
        const known = Object.hasOwn(englishErrors, this.code);
        displayed = known ? englishErrors[this.code] : displayed;
        if (!known && /(?:^|_)forbidden$/.test(this.code)) displayed = 'You do not have permission to perform this action.';
        if (!known && /(?:^|_)not_found$/.test(this.code)) displayed = 'The requested resource was not found.';
      }
      return `${this.code}: ${displayed}`;
    } });
  }
}
