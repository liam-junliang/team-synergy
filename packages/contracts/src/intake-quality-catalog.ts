import type { IntakeArtifactType } from './intake.js';

export interface EnterpriseArtifact {
  type: IntakeArtifactType;
  title: string;
  kind: 'requirement_document' | 'architecture';
  required: boolean;
  sections: string[];
  purpose: string;
}

export const ENTERPRISE_ARTIFACTS: EnterpriseArtifact[] = [
  {
    type: 'charter', title: '项目章程与业务背景', kind: 'requirement_document', required: true,
    purpose: '说明为什么做、为谁做、做到什么程度，以及不做什么。',
    sections: ['业务背景', '问题与目标', '范围与非目标', '干系人', '成功指标', '约束与假设'],
  },
  {
    type: 'context', title: '系统上下文与角色', kind: 'requirement_document', required: true,
    purpose: '说明系统边界、外部依赖、用户角色和关键运行约束。',
    sections: ['系统上下文', '外部系统', '用户角色', '关键场景', '运行约束'],
  },
  {
    type: 'domain', title: '领域模型与术语', kind: 'requirement_document', required: true,
    purpose: '统一业务语言、实体、状态机和权限矩阵。',
    sections: ['术语表', '领域实体', '状态机', '权限矩阵', '业务规则'],
  },
  {
    type: 'requirements', title: '功能需求规格', kind: 'requirement_document', required: true,
    purpose: '用可测试的需求和验收场景描述系统当前行为。',
    sections: ['需求范围', '功能需求', '验收场景', '权限边界', '异常与边界', '追溯'],
  },
  {
    type: 'nfr', title: '非功能需求规格', kind: 'requirement_document', required: true,
    purpose: '把性能、可用性、安全、可观测性和可维护性写成可度量约束。',
    sections: ['性能', '可用性', '安全与隐私', '可观测性', '可维护性', '容量与成本'],
  },
  {
    type: 'architecture', title: '架构说明', kind: 'architecture', required: true,
    purpose: '用 C4/arc42 视角说明组件、部署、数据、质量属性和取舍。',
    sections: ['架构上下文', '容器与组件', '部署与运行', '数据与集成', '质量属性', '风险与取舍'],
  },
  {
    type: 'api_data', title: 'API 与数据契约', kind: 'requirement_document', required: true,
    purpose: '记录端点、鉴权、错误模型、实体关系和数据生命周期。',
    sections: ['API 清单', '鉴权与错误模型', '数据实体与关系', '数据保留与迁移', '版本与兼容'],
  },
  {
    type: 'test_strategy', title: '测试策略与追溯', kind: 'requirement_document', required: true,
    purpose: '说明测试分层、环境、覆盖和需求到测试的追溯。',
    sections: ['测试分层', '测试环境', '覆盖与追溯', '证据与报告', '未验证项'],
  },
  {
    type: 'security', title: '安全与权限设计', kind: 'requirement_document', required: true,
    purpose: '说明信任边界、威胁、身份权限、数据分级和审计。',
    sections: ['信任边界', '威胁与缓解', '身份与权限', '数据分级', '审计与密钥'],
  },
  {
    type: 'runbook', title: '运维与发布手册', kind: 'requirement_document', required: true,
    purpose: '让值班人员可以部署、回滚、恢复和排障。',
    sections: ['部署', '回滚', '备份与恢复', '告警与 SLO', '故障处理'],
  },
  {
    type: 'adr', title: '架构决策记录', kind: 'requirement_document', required: true,
    purpose: '记录架构上重要的选择、备选方案、后果和确认方式。',
    sections: ['背景与问题', '决策驱动', '候选方案', '决策', '后果与确认'],
  },
  {
    type: 'onboarding', title: '开发与接入指南', kind: 'requirement_document', required: false,
    purpose: '让新成员可以启动、开发、测试和发布。',
    sections: ['前置条件', '本地启动', '开发流程', '测试与发布', '常见问题'],
  },
  {
    type: 'risk', title: '风险与缺口登记', kind: 'requirement_document', required: false,
    purpose: '登记未验证项、技术债和交付风险，并指定负责人和复查日期。',
    sections: ['风险登记', '影响与概率', '缓解措施', '负责人', '复查日期'],
  },
];

