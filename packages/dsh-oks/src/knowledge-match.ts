export const normalizeLexical=(s:string)=>s.normalize('NFKC').toLowerCase();
export const lexicalWords=(s:string)=>normalizeLexical(s.replace(/([a-z])([A-Z])/g,'$1 $2')).match(/[\p{L}\p{N}]+/gu)??[];
function nearWord(a:string,b:string):boolean {
  if(a.length<4||b.length<4||!/^[a-z]+$/.test(a)||!/^[a-z]+$/.test(b)||Math.abs(a.length-b.length)>1)return false;
  if(a.length===b.length){const ds=[...a].flatMap((c,i)=>c===b[i]?[]:[i]);return ds.length===1||ds.length===2&&ds[1]===ds[0]+1&&a[ds[0]]===b[ds[1]]&&a[ds[1]]===b[ds[0]];}
  const [short,long]=a.length<b.length?[a,b]:[b,a];let i=0;while(i<short.length&&short[i]===long[i])i++;return short.slice(i)===long.slice(i+1);
}
export function lexicalQuery(query:string){
  const terms=[...new Set(lexicalWords(query))];
  if(!terms.length)throw new Error('search requires searchable words');
  return {phrase:normalizeLexical(query.trim()),terms};
}
export function matchLexical(query:ReturnType<typeof lexicalQuery>,input:{field:string;text:string;weight:number}[]){
  const fields=input.map(f=>({...f,text:normalizeLexical(f.text),words:lexicalWords(f.text)}));
  const hits=query.terms.flatMap(term=>{
    const candidates=fields.flatMap(f=>{
      const strength=f.text===term?3:f.text.includes(term)?2:f.words.some(word=>nearWord(term,word))?1:0;
      return strength?[{field:f.field,score:strength*10+f.weight}]:[];
    });
    return candidates.length?[{term,fields:[...new Set(candidates.map(h=>h.field))].sort(),score:Math.max(...candidates.map(h=>h.score))}]:[];
  });
  const score=hits.length?hits.length*1000+Math.max(...fields.map(f=>f.text===query.phrase?200:f.text.includes(query.phrase)?100:0))+hits.reduce((n,h)=>n+h.score,0)/query.terms.length:0;
  return {score,hits};
}
