import { readAndValidate } from './validate.mjs';
const [path='output/TC01/report.json', id, input] = process.argv.slice(2);
const errs=readAndValidate(path, id, input);
if(errs.length) {console.error('構造検証NG:\n- '+errs.join('\n- '));process.exitCode=1;}
else console.log('構造検証OK（意味・妥当性は未検証）');
