const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function formatResult({text,format}){
 if(typeof text!=='string'||!text.trim()||text.length>100000)throw Error('Укажите результат до 100000 символов');
 if(!['text','markdown','sql','wiki'].includes(format))throw Error('Неизвестный формат');
 if(format==='sql'){const match=text.trim().match(/^```(?:sql)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);return {text:match?match[1]:text};}
 if(format!=='wiki')return {text};
 const lines=text.split(/\r?\n/),html=[],list=[];let code=false,codeLines=[];
 const closeLevel=()=>{const level=list.pop();html.push('</li></'+level.type+'>');};
 const closeList=()=>{while(list.length)closeLevel();};
 const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(s=>s.trim().replace(/\\\|/g,'|'));
 for(let index=0;index<lines.length;index++){
  const line=lines[index];if(/^```/.test(line)){closeList();if(code){html.push('<pre><code>'+escape(codeLines.join('\n'))+'</code></pre>');codeLines=[];}code=!code;continue;}
  if(code){codeLines.push(line);continue;}
  if(index+1<lines.length&&line.includes('|')&&cells(lines[index+1]).every(s=>/^:?-{3,}:?$/.test(s))){closeList();const header=cells(line);html.push('<table><thead><tr>'+header.map(c=>'<th>'+escape(c)+'</th>').join('')+'</tr></thead><tbody>');index++;
   while(index+1<lines.length&&lines[index+1].includes('|')&&lines[index+1].trim()){const row=cells(lines[++index]);html.push('<tr>'+row.map(c=>'<td>'+escape(c)+'</td>').join('')+'</tr>');}html.push('</tbody></table>');continue;
  }
  const heading=line.match(/^(#{1,6})\s+(.+)$/);if(heading){closeList();const n=heading[1].length;html.push('<h'+n+'>'+escape(heading[2])+'</h'+n+'>');continue;}
  const bullet=line.match(/^([ \t]*)([-*]|\d+[.)])\s+(.+)$/);if(bullet){let indent=bullet[1].replace(/\t/g,'    ').length;const type=/^\d/.test(bullet[2])?'ol':'ul';
   if(list.length>=20&&indent>list.at(-1).indent)indent=list.at(-1).indent;
   while(list.length&&list.at(-1).indent>indent)closeLevel();
   if(list.length&&list.at(-1).indent===indent&&list.at(-1).type!==type)closeLevel();
   if(!list.length||indent>list.at(-1).indent){html.push('<'+type+'><li>');list.push({indent,type});}else html.push('</li><li>');
   html.push(escape(bullet[3]));continue;
  }
  closeList();if(line.trim())html.push('<p>'+escape(line)+'</p>');
 }
 closeList();if(codeLines.length)html.push('<pre><code>'+escape(codeLines.join('\n'))+'</code></pre>');
 return {text,html:html.join('\n')};
}
module.exports={formatResult};
