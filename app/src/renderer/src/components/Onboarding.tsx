import { useState } from 'react';
import { SCENARIOS, SCENARIO_HINTS } from '@shared/scenario';
import type { ObjectKind, ScenarioKind } from '@shared/types';
import { useStore } from '../store';

const STEPS = ['欢迎', '端点', '认证', '对象', 'Inbox'] as const;

export function Onboarding({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [step, setStep] = useState(0);
  const [scenario, setScenario] = useState<ScenarioKind>('求职面试');
  const [wsName, setWsName] = useState('我的工作区');
  const [kind, setKind] = useState<ObjectKind>('组织');
  const [objName, setObjName] = useState('');

  const skip = () => {
    dispatch({ type: 'SET_ONBOARDING', done: true });
    onClose();
  };

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));

  return (
    <div className="desktop" style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(15,17,20,0.45)' }}>
      <div className="window" style={{ width: 480, height: 'auto', margin: '10vh auto', padding: 24 }}>
        <p className="dim">
          第 {step + 1} / {STEPS.length} 步 · {STEPS[step]}（可跳过）
        </p>
        {step === 0 && (
          <>
            <h2>欢迎使用 StaffDesk</h2>
            <p>先选一个场景，建第一个工作区。默认说明书已按场景预置，可稍后改。</p>
            <div className="ws-kinds scenario-kinds">
              {SCENARIOS.map((s) => (
                <button key={s} type="button" className={scenario === s ? 'on' : ''} onClick={() => setScenario(s)}>
                  {s}
                </button>
              ))}
            </div>
            <p className="dim">{SCENARIO_HINTS[scenario]}</p>
            <input value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="工作区名称" />
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (wsName.trim()) dispatch({ type: 'ADD_WORKSPACE', name: wsName, scenario });
                next();
              }}
            >
              建工作区
            </button>
          </>
        )}
        {step === 1 && (
          <>
            <h2>配自己的端点</h2>
            <p>在设置里填兼容端点的 Key。这一步只做连通，不扣额度。</p>
            <p className="dim">现在可跳过，之后在设置页继续。</p>
            <button type="button" className="primary" onClick={next}>
              下一步
            </button>
          </>
        )}
        {step === 2 && (
          <>
            <h2>资格认证</h2>
            <p>默认会跑当前场景的虚构金标包。可跳过；未认证徽章会留在设置页。</p>
            <button type="button" className="primary" onClick={next}>
              稍后认证
            </button>
          </>
        )}
        {step === 3 && (
          <>
            <h2>建第一个对象</h2>
            <div className="ws-kinds">
              {(['人', '组织', '项目'] as const).map((k) => (
                <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                  {k}
                </button>
              ))}
            </div>
            <input value={objName} onChange={(e) => setObjName(e.target.value)} placeholder="例如：要面的公司" />
            <button
              type="button"
              className="primary"
              onClick={() => {
                if (objName.trim()) dispatch({ type: 'ADD_OBJECT', kind, name: objName });
                next();
              }}
            >
              创建
            </button>
          </>
        )}
        {step === 4 && (
          <>
            <h2>去 Inbox 丢材料</h2>
            <p>粘贴文本或链接。未绑定的材料不会投影到对象上。绑定须你确认。</p>
            <button
              type="button"
              className="primary"
              onClick={() => {
                dispatch({ type: 'SET_VIEW', view: { kind: 'inbox' } });
                skip();
              }}
            >
              进入 Inbox
            </button>
          </>
        )}
        <div className="ws-draft-actions" style={{ marginTop: 16 }}>
          <button type="button" className="ghost small" onClick={skip}>
            跳过向导
          </button>
          {step > 0 && step < 4 && (
            <button type="button" className="ghost small" onClick={() => setStep((s) => s - 1)}>
              上一步
            </button>
          )}
        </div>
        {state.workspaces.length > 0 && <p className="dim">当前工作区：{state.workspaces.map((w) => w.name).join('、')}</p>}
      </div>
    </div>
  );
}
