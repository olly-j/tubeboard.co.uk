// Pure ADR024 assessment of exact archived comparisons. No observation, HTTP,
// status, or response clock is fabricated, and no departures are published here.
import { createHash } from 'node:crypto';
import { parseBoundedJSON } from './bounded-json.js';
import { londonLocal, validBoard } from './station-board-v2.js';
import { validatedPublicationProof, selectedTimetableEntry, assessTimetableComparison } from './station-board-timetable.js';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=(identity,record,direction,bodySHA256)=>`${identity.publicationSHA256}\0${identity.proofBodySHA256}\0${record.lineID}\0${record.stationID}\0${direction??'default'}\0${bodySHA256}`;
const scopeValid=value=>typeof value==='string' && /^[a-z0-9-]{1,64}\/[A-Z0-9]{1,32}$/.test(value) && validBoard(value.split('/')[1],value.split('/')[0]);
export function assessCurrentPublicationCoverage({asset,comparisonIndex,requestedScopes=[],mandatoryScopes=[],at}={}) {
  const identity=asset?.identity??{};
  const result={valid:false,publicationSHA256:identity.publicationSHA256,proofRevision:identity.proofRevision,proofBodySHA256:identity.proofBodySHA256,serviceDay:null,assessedAt:at,requiredScopes:[],assessedScopes:[],coveredScopes:[],unresolvedScopes:[],reason:'assessment-input-invalid'};
  try {
    if(!Number.isFinite(at) || !Array.isArray(requestedScopes) || requestedScopes.length>512 || new Set(requestedScopes).size!==requestedScopes.length || requestedScopes.some(s=>!scopeValid(s))
      || !Array.isArray(mandatoryScopes) || mandatoryScopes.length>256 || new Set(mandatoryScopes).size!==mandatoryScopes.length || mandatoryScopes.some(s=>!scopeValid(s)))return result;
    const proof=validatedPublicationProof(asset),day=londonLocal(at).slice(0,10);
    const publicationRequiredScopes=[...new Set(proof.entries.filter(e=>e.status==='qualified').map(e=>`${e.lineID}/${e.stationID}`))].sort();
    const requiredScopes=[...new Set([...publicationRequiredScopes,...mandatoryScopes])].sort();
    const required=new Set(requiredScopes),scopes=[...new Set([...requiredScopes,...requestedScopes])].sort();
    if(requiredScopes.length>256 || requestedScopes.filter(s=>!required.has(s)).length>256 || !scopes.length || scopes.length>512 || scopes.some(s=>!scopeValid(s)))return result;
    Object.assign(result,{valid:true,serviceDay:day,publicationRequiredScopes,requiredScopes,assessedScopes:scopes,reason:'current-service-day-assessed'});
    for(const scope of scopes){
      try {
        if(!comparisonIndex || comparisonIndex.isUnavailable(identity.publicationSHA256,identity.proofBodySHA256))throw Error('archive');
        const [lineID,stationID]=scope.split('/'),record={lineID,stationID};
        const {entry,sets}=selectedTimetableEntry(asset,record);
        const responses=sets.map(definition=>{
          const direction=definition.direction,evidence=direction===null?entry:entry.directionalSourceEvidence?.find(d=>d.direction===direction),bodySHA256=evidence?.apiBodySHA256;
          const source=comparisonIndex.get(key(identity,record,direction,bodySHA256));
          if(!source || source.publicationSHA256!==identity.publicationSHA256 || source.proofBodySHA256!==identity.proofBodySHA256 || source.lineID!==lineID || source.stationID!==stationID || source.direction!==(direction??'default') || source.bodySHA256!==bodySHA256 || !Buffer.isBuffer(source.body) || source.body.length<1 || source.body.length>8*1024*1024 || digest(source.body)!==bodySHA256)throw Error('archive');
          return {direction,bodySHA256,value:parseBoundedJSON(source.body,8*1024*1024,64)};
        });
        assessTimetableComparison(asset,responses,record,at);result.coveredScopes.push(scope);
      }catch{result.unresolvedScopes.push(scope);}
    }
  }catch{return result;}
  return result;
}
