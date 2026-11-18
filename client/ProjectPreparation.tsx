import { BookOpen, RefreshCw } from 'lucide-react';
import { PREPARATION_HYPOTHESES, PREPARATION_OVERVIEW } from '../shared/types';
import type { Material, PreparationSource, ProjectPreparation as Preparation } from '../shared/types';
import { Spinner, formatDate } from './ui';

const overviewLabels = {
  company: '公司', product: '产品', customers: '客户', problem: '客户问题',
  technicalApproach: '技术路线', businessModel: '商业模式', keyMetrics: '牵引力与关键指标', financing: '融资需求',
};
const hypothesisLabels = { businessModel: '商业模式', growth: '增长', unitEconomics: '单位经济', moat: '技术壁垒' };

interface Props {
  materials: Material[];
  preparation?: Preparation;
  stale?: boolean;
  canEdit: boolean;
  pending: boolean;
  onGenerate: () => void;
  onSource: (material: Material, page: number) => void;
}

export function ProjectPreparation({ materials, preparation, stale, canEdit, pending, onGenerate, onSource }: Props) {
  const readable = materials.some(material => material.pages.some(page => page.text.trim()));
  const showCitation = (source: PreparationSource) => {
    const material = materials.find(item => item.id === source.materialId);
    if (!material) return null;
    return <button type="button" className="preparation-citation" onClick={() => onSource(material, source.page)}>
      <span><BookOpen size={13} />资料页引文 · {material.name} · 第 {source.page} 页</span>
      <q>{source.quote}</q>
    </button>;
  };

  return <section className="project-preparation" aria-labelledby="project-preparation-title" aria-busy={pending}>
    <header className="section-heading">
      <div><h2 id="project-preparation-title">会前研判</h2>
        {preparation && <p>更新于 {formatDate(preparation.generatedAt)} · 采用 {preparation.inspectedPages}/{preparation.totalPages} 页文字{preparation.excerpted && ' · 部分页仅采用节选或未纳入'}</p>}
      </div>
      {canEdit && readable && <button className="button secondary" disabled={pending} onClick={onGenerate}>
        {pending ? <Spinner text="正在整理会前研判" /> : <><RefreshCw size={15} />{preparation || stale ? '更新会前研判' : '生成会前研判'}</>}
      </button>}
    </header>
    {!preparation ? <p className="muted" role="status">{pending
      ? '正在根据项目资料整理会前研判。'
      : stale ? '项目资料已更新，待重新生成会前研判。'
      : readable ? '待生成会前研判。' : '项目资料尚无可用页文字。'}</p>
      : <>
        <div className="preparation-columns">
          <section>
            <h3>公司陈述</h3>
            <p className="preparation-scope">AI 归纳（未独立核实）。引文对应项目中的当前页文字，可能包含人工修订。</p>
            <dl>{PREPARATION_OVERVIEW.map(key => {
              const item = preparation.overview[key];
              return <div key={key}><dt>{overviewLabels[key]}</dt><dd>
                {item ? <><p>{item.statement}</p>{showCitation(item.source)}</> : <span className="muted">本次未找到依据</span>}
              </dd></div>;
            })}</dl>
          </section>
          <section>
            <h3>待验证的 AI 假设</h3>
            <dl>{PREPARATION_HYPOTHESES.map(key => {
              const item = preparation.hypotheses[key];
              return <div key={key}><dt>{hypothesisLabels[key]}</dt><dd>
                {item ? <><p>{item.assumption}</p><p><strong>待核实</strong> {item.gap}</p>{showCitation(item.source)}</>
                  : <span className="muted">本次未找到可核对依据</span>}
              </dd></div>;
            })}</dl>
          </section>
        </div>
        <section className="preparation-questions">
          <h3>优先追问</h3>
          {preparation.questions.length ? <ol>{preparation.questions.map(question => <li key={question.text}>
            <h4>{question.text}</h4>
            <p><strong>为何重要</strong> {question.why}</p>
            <p><strong>希望取得的证据</strong> {question.evidenceWanted}</p>
            {showCitation(question.source)}
          </li>)}</ol> : <p className="muted">目前未找到有材料依据的优先追问。</p>}
        </section>
      </>}
  </section>;
}
