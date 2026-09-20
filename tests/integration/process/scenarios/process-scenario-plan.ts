/**
 * T007b process-QA scenario catalogue.
 *
 * This file is **plan data**, not an executable acceptance suite. It records
 * which process lifecycle / ownership scenarios the QA must run once the T005
 * candidate public interface exists (#5), together with how each scenario will
 * be made deterministic and whether its evidence is real or injected.
 *
 * Status is `blocked` for every entry until `packages/runtime/src/process`
 * (and `reconcile`, `credentials`) land plus the T005a/T005b sub-slices expose
 * their public surfaces. `harness.test.ts` checks this catalogue for internal
 * consistency; it does not run the scenarios and must never be cited as process
 * validation.
 */

export type EvidenceKind = 'real' | 'injected' | 'fixture';

export type InterfaceCapability =
  | 'process.start'
  | 'process.stop'
  | 'process.readiness'
  | 'process.port-conflict'
  | 'process.ownership'
  | 'process.reconcile'
  | 'dataRoot.lock'
  | 'credential.resolve'
  | 'webui.open'
  | 'install.managed';

export interface PlannedScenario {
  readonly id: string;
  readonly title: string;
  readonly requirements: readonly string[];
  readonly evidence: EvidenceKind;
  /** A deterministic gate that replaces sleep/retry luck. */
  readonly determinismGate: string;
  readonly requires: readonly InterfaceCapability[];
  /** Why the scenario cannot run yet, or `undefined` once the candidate exists. */
  readonly status: 'blocked' | 'ready';
  readonly blocker?: string;
}

export const PROCESS_SCENARIOS: readonly PlannedScenario[] = [
  {
    id: 'PROC-OWN-01',
    title: '停止只作用于自己拥有的进程，无关对照进程存活',
    requirements: ['SC-002', 'FR-005'],
    evidence: 'real',
    determinismGate: '受管进程写入 ready 文件后，QA 记录 token+lstart；stop 完成后按身份校验对照进程仍存活',
    requires: ['process.start', 'process.stop', 'process.ownership'],
    status: 'blocked',
    blocker: 'packages/runtime/src/process 未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-TREE-01',
    title: '暂停/停止覆盖子进程与孙进程整棵树',
    requirements: ['SC-002', 'FR-005'],
    evidence: 'real',
    determinismGate: 'fixture-process 在 ready 前完成孙进程 record 握手；stop 后轮询孙进程 record 的 lstart 确认消失',
    requires: ['process.start', 'process.stop', 'process.ownership'],
    status: 'blocked',
    blocker: 'packages/runtime/src/process 未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-PID-01',
    title: 'PID 误杀防护：身份不匹配时拒绝终止',
    requirements: ['FR-005'],
    evidence: 'injected',
    determinismGate: '对无关对照进程使用伪造 token 调用 killGuarded，必须抛 OwnershipError 且对照进程仍存活；负向对照',
    requires: ['process.ownership'],
    status: 'blocked',
    blocker: 'process ownership 接口未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-PORT-01',
    title: '端口冲突返回 PORT_UNAVAILABLE 且不误杀占用者',
    requirements: ['FR-005'],
    evidence: 'real',
    determinismGate: 'occupyLoopbackPort 先占端口，再启动受管进程；冲突为确定性门控，占用者按身份校验存活',
    requires: ['process.start', 'process.port-conflict'],
    status: 'blocked',
    blocker: 'packages/runtime/src/process 未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-READY-01',
    title: 'loopback 就绪后可探测，停止后端口释放',
    requirements: ['FR-005', 'SC-003'],
    evidence: 'real',
    determinismGate: 'bind mode 写 ready 文件带 port；httpProbe 200；stop 后 isLoopbackPortBound=false（轮询有限超时）',
    requires: ['process.start', 'process.readiness', 'process.stop'],
    status: 'blocked',
    blocker: 'packages/runtime/src/process 未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-TIMEOUT-01',
    title: '就绪超时返回 START_TIMEOUT 并回收进程树',
    requirements: ['FR-005', 'SC-003'],
    evidence: 'injected',
    determinismGate: 'never-ready fixture 确定性不写 ready 文件；断言超时终态与进程树回收，不靠 sleep',
    requires: ['process.start', 'process.readiness', 'process.ownership'],
    status: 'blocked',
    blocker: 'packages/runtime/src/process 未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-CANCEL-01',
    title: '取消启动：提交前 cancelled，提交后 CANNOT_CANCEL',
    requirements: ['FR-005', 'FR-006'],
    evidence: 'injected',
    determinismGate: '文件 gate 卡在 ready 前，cancel 与 release 顺序完全确定',
    requires: ['process.start', 'process.reconcile'],
    status: 'blocked',
    blocker: 'operations.cancel 的进程语义未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-CRASH-01',
    title: '受管进程崩溃进入 PROCESS_EXITED 终态，不伪报 running',
    requirements: ['FR-005', 'FR-008'],
    evidence: 'real',
    determinismGate: 'crash mode 写 ready 后立即 exit(3) 并遗留孙进程；退出由 close 事件判定，不靠 sleep',
    requires: ['process.start', 'process.reconcile'],
    status: 'blocked',
    blocker: 'packages/runtime/src/reconcile 未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-RESTART-01',
    title: '崩溃后重启 reconcile 接管孤儿进程并清理',
    requirements: ['FR-008', 'SC-004'],
    evidence: 'real',
    determinismGate: '崩溃遗留的孙进程 record（token+lstart）是确定性输入；重启后按身份回收或标记',
    requires: ['process.reconcile', 'process.ownership'],
    status: 'blocked',
    blocker: 'packages/runtime/src/reconcile 未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-LOCK-01',
    title: 'dataRoot 双实例独占：活跃持锁方有界拒绝或串行',
    requirements: ['FR-001', 'FR-008'],
    evidence: 'real',
    determinismGate: '两个 instance fixture 共享一个 dataRoot，各写 ready 后进入竞争；用文件 gate 固定交错顺序',
    requires: ['dataRoot.lock', 'process.start'],
    status: 'blocked',
    blocker: 'dataRoot 独占锁未实现（#43 T005a 无候选 PR）',
  },
  {
    id: 'PROC-LOCK-02',
    title: '持锁方崩溃后可接管，且不回滚他人活跃事务',
    requirements: ['FR-008'],
    evidence: 'injected',
    determinismGate: '持锁实例在提交边界退出（crash mode），接管方按身份/边界校验接管而非盲删锁',
    requires: ['dataRoot.lock', 'process.reconcile'],
    status: 'blocked',
    blocker: 'dataRoot 独占锁未实现（#43 T005a 无候选 PR）',
  },
  {
    id: 'PROC-LOCK-03',
    title: '双进程同时接管同一陈旧锁：不得归档/删除新 owner 的锁',
    requirements: ['FR-008'],
    evidence: 'real',
    determinismGate: '两个真实子进程用文件 contentionGate 固定进入接管顺序，不使用 sleep/stale 时间赌时序',
    requires: ['dataRoot.lock', 'process.start'],
    status: 'blocked',
    blocker: 'core 锁生命周期可观测接口未冻结（会话 hdsl-20/hdsl-21 无候选 PR）',
  },
  {
    id: 'PROC-LOCK-04',
    title: '旧 owner release 不得删除替代锁（ABA）',
    requirements: ['FR-008'],
    evidence: 'real',
    determinismGate: 'gate 保证接管完成后再触发旧 owner release；断言 epoch/owner 不变，旧 release 幂等失败',
    requires: ['dataRoot.lock'],
    status: 'blocked',
    blocker: 'core 锁生命周期可观测接口未冻结（会话 hdsl-20/hdsl-21 无候选 PR）',
  },
  {
    id: 'PROC-LOCK-05',
    title: 'close 时仍有安装/进程写任务，不得释放 dataRoot 让新实例并发写',
    requirements: ['FR-008'],
    evidence: 'injected',
    determinismGate: '注入器在写任务持有期间调用 close；断言新实例被有界拒绝，写任务按序收尾',
    requires: ['dataRoot.lock', 'install.managed', 'process.start'],
    status: 'blocked',
    blocker: 'core 锁/close 生命周期可观测接口未冻结（会话 hdsl-20/hdsl-21 无候选 PR）',
  },
  {
    id: 'PROC-LOCK-06',
    title: 'owner/heartbeat 损坏、异 host、PID 复用一律保守拒绝且不杀无关进程',
    requirements: ['FR-005', 'FR-008'],
    evidence: 'injected',
    determinismGate: 'LockFixture 制造 stale/foreign/pid-reuse/corrupt 输入；PID-reuse 用真实存活对照进程，身份校验拒绝且进程存活',
    requires: ['dataRoot.lock', 'process.ownership'],
    status: 'blocked',
    blocker: 'core 锁生命周期可观测接口未冻结（会话 hdsl-20/hdsl-21 无候选 PR）',
  },
  {
    id: 'PROC-LOCK-07',
    title: '三方竞争：A 观察陈旧→B 建新 lease→A 移动 B→C 空隙 wx，不得出现两个 writer',
    requirements: ['FR-008'],
    evidence: 'injected',
    determinismGate: '三方 contentionGate 固定 A/B/C 交错；OrderingLedger 记录 writer-enter/exit 并 assertNoConcurrentWriters 失败于任何重叠',
    requires: ['dataRoot.lock', 'process.start', 'process.ownership'],
    status: 'blocked',
    blocker: 'rename 后校验/link 还原非 CAS，锁方案待会话 hdsl-21 修订；#5 专职设计审未完成',
  },
  {
    id: 'PROC-LOCK-08',
    title: '旧 owner heartbeat/lease 覆写不得使新 owner 失配或复活（fencing）',
    requirements: ['FR-008'],
    evidence: 'injected',
    determinismGate: '新 owner 建立后写入旧 owner heartbeat/lease；断言被拒或无副作用，新 owner epoch/身份不变',
    requires: ['dataRoot.lock'],
    status: 'blocked',
    blocker: '锁 fencing/epoch 语义待会话 hdsl-21 修订后冻结（#5 专职设计审未完成）',
  },
  {
    id: 'PROC-CLOSE-01',
    title: '正常 close 先停并 await 所有自有 DSH/安装/预检子树退出，再释放锁；下一实例在旧写者退出后才获锁',
    requirements: ['FR-008'],
    evidence: 'real',
    determinismGate: '真实 writer 子进程与 close/下一实例向 OrderingLedger 写 writer-exit/lock-release/next-acquire，断言严格顺序；无关对照进程存活',
    requires: ['dataRoot.lock', 'process.stop', 'process.ownership'],
    status: 'blocked',
    blocker: 'core 锁/close 生命周期可观测接口未冻结（会话 hdsl-20/hdsl-21 无候选 PR）',
  },
  {
    id: 'PROC-CRED-01',
    title: '凭据引用注入显式受限子进程 env，值不落环境文件/日志/错误',
    requirements: ['FR-003', 'FR-007'],
    evidence: 'real',
    determinismGate: '专用 canary 引用（hdsl-qa-canary-*）由 fixture 写入 OS store 引用；子进程回显 env 的哈希而非原文',
    requires: ['credential.resolve', 'process.start'],
    status: 'blocked',
    blocker: '端到端凭据注入需 #5 进程端口；#44 候选 PR #46 已提供机制层',
  },
  {
    id: 'PROC-CRED-02',
    title: '无引用/缺失/取消失败且错误不含凭据值',
    requirements: ['FR-003', 'FR-007'],
    evidence: 'injected',
    determinismGate: '移除/撤销引用后启动，断言失败终态且以 canary 字符串全量扫描错误与日志',
    requires: ['credential.resolve', 'process.start'],
    status: 'blocked',
    blocker: '端到端凭据失败路径需 #5 进程端口；#44 候选 PR #46 已提供机制层',
  },
  {
    id: 'PROC-WEBUI-01',
    title: 'openWebUI 只打开属于当前受管进程的 loopback endpoint',
    requirements: ['FR-004'],
    evidence: 'real',
    determinismGate: 'bind fixture 的 recorded port 是唯一合法来源；换端口/停进程后必须 WEBUI_UNAVAILABLE',
    requires: ['webui.open', 'process.start'],
    status: 'blocked',
    blocker: 'openWebUI 进程归属校验依赖 #5（T006 next slice）',
  },
  {
    id: 'PROC-HOME-01',
    title: '所有进程场景宿主 HOME 与 ~/.dsh 快照不变',
    requirements: ['FR-001', 'FR-003'],
    evidence: 'real',
    determinismGate: 'captureHostDefaults 前后逐字节比较；快照差异是确定性判据',
    requires: ['process.start', 'process.stop'],
    status: 'blocked',
    blocker: '依赖真实进程场景，候选接口未实现（#5 无候选 PR）',
  },
  {
    id: 'PROC-REAL-01',
    title: '真实受管 DSH 两环境 loopback 就绪/停止（不调用模型）',
    requirements: ['SC-001', 'SC-002', 'FR-005'],
    evidence: 'real',
    determinismGate: '受管安装产物 + 专用 canary 凭据 + `--no-open --port 0`；就绪行/端口为门控，仅 SIGTERM，无模型调用',
    requires: ['install.managed', 'process.start', 'process.readiness', 'process.stop', 'credential.resolve'],
    status: 'blocked',
    blocker: '真实 DSH 进程 QA 依赖 #5 候选与 #43/#44 接口；当前不存在',
  },
];

/** True while any planned scenario still has no runnable candidate interface. */
export const candidateBlockers = (): readonly string[] => {
  const unique = new Set<string>();
  for (const scenario of PROCESS_SCENARIOS) {
    if (scenario.status === 'blocked' && scenario.blocker !== undefined) {
      unique.add(scenario.blocker);
    }
  }
  return [...unique];
};

export const REQUIRED_CAPABILITIES: readonly InterfaceCapability[] = [
  'process.start',
  'process.stop',
  'process.readiness',
  'process.port-conflict',
  'process.ownership',
  'process.reconcile',
  'dataRoot.lock',
  'credential.resolve',
  'webui.open',
  'install.managed',
];
