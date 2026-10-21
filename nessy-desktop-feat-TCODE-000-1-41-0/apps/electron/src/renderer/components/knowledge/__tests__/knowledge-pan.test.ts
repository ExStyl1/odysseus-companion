import {test,expect} from 'bun:test'
import {createGraphPan} from '../knowledge-pan'
test('rapid moves coalesce and deferred updates survive pointer release',()=>{
 const frames=new Map<number,()=>void>(),updates:Array<()=>void>=[];let id=0,view={x:0,y:0,zoom:2}
 const pan=createGraphPan(point=>updates.push(()=>{view={...view,...point}}),callback=>{frames.set(++id,callback);return id},id=>{frames.delete(id)})
 pan.start(10,20,5,7)
 for(let i=0;i<100;i++)pan.move(10+i,20+i,500)
 expect(frames.size).toBe(1)
 const frame=[...frames.values()][0]!;frames.clear();frame()
 pan.end();updates.forEach(update=>update())
 expect(view).toEqual({x:203,y:205,zoom:2})
})
test('switching views cancels queued movement and zero-width surfaces are ignored',()=>{
 const frames=new Map<number,()=>void>();let id=0,calls=0
 const pan=createGraphPan(()=>{calls++},callback=>{frames.set(++id,callback);return id},id=>{frames.delete(id)})
 for(let i=0;i<100;i++){pan.start(0,0,0,0);pan.move(10,10,500);pan.end(false)}
 expect(frames.size).toBe(0);expect(calls).toBe(0)
 pan.start(0,0,0,0);pan.move(10,10,0);expect(frames.size).toBe(0)
})
