import assert from 'node:assert/strict';
import {isResultColumn,RESULT_TYPES} from './src/results.ts';
for(const type of ['Int','Float','Bool','String','DateTimeUtc','DateTime','EpochMillis']) {
  for(const nullable of [true,false])assert.equal(isResultColumn({name:'value',type,nullable}),true,type);
}
for(const type of ['DatetimeUtc','LocalDateTime','LocalEpochMillis','DateUtc','DateTimeTz','DateTimeOffset']) {
  assert.equal(isResultColumn({name:'value',type,nullable:false}),false,type);
}
assert.equal(isResultColumn({name:'value',type:'DateTimeUtc',nullable:'false'}),false);
assert.deepEqual(RESULT_TYPES,['Int','Float','Bool','String','DateTimeUtc','EpochMillis','DateTime']);
console.log('Time result contract: DateTimeUtc/DateTime/EpochMillis accepted; stale names and unsupported types rejected');
