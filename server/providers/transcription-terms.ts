const MAX_TERMS = 20;
const MAX_TERM_LENGTH = 60;
const supported = /^[A-Za-z]+(?:[ -]+[A-Za-z]+)*$/;

function valid(term: string) {
 return term.length <= MAX_TERM_LENGTH && supported.test(term);
}

export function validateTranscriptionTerms(value: unknown): string {
 if(typeof value!=='string')throw new Error('转写术语应为文字，每行一项');
 const terms=value.split(/\r?\n/).map(term=>term.trim()).filter(Boolean);
 if(terms.length>MAX_TERMS||!terms.every(valid)){
  throw new Error('最多填写 20 个转写术语，每行最多 60 个字符，只使用英文字母、空格或连字符');
 }
 return terms.join('\n');
}

export function localTranscriptionTerms(projectTerms: readonly string[], modelingUnit: 'cjkchar+bpe' | 'bpe' = 'cjkchar+bpe') {
 const manual=(process.env.ASR_HOTWORDS||'').split(/\r?\n/);
 const terms=[...manual,...projectTerms].map(term=>term.trim()).filter(valid);
 const normalize=(term:string)=>modelingUnit==='bpe'?term.replace(/ +/g,' '):term.replace(/[ -]+/g,' ').toUpperCase();
 return [...new Set(terms.map(normalize))].slice(0,MAX_TERMS);
}
