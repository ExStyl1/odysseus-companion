/** Coalesce pointer events; deferred React updates receive immutable coordinates. */
export function createGraphPan(
 apply:(point:{x:number;y:number})=>void,
 schedule:(callback:()=>void)=>number=callback=>requestAnimationFrame(callback),
 cancel:(id:number)=>void=id=>cancelAnimationFrame(id),
){
 let origin:{x:number;y:number;px:number;py:number}|null=null
 let point:{x:number;y:number}|null=null,frame:number|null=null
 const end=(flush=true)=>{
  const final=point
  origin=null;point=null
  if(frame!==null)cancel(frame)
  frame=null
  if(flush&&final)apply(final)
 }
 return{
  start(x:number,y:number,px:number,py:number){end(false);origin={x,y,px,py}},
  move(x:number,y:number,width:number){
   const start=origin
   if(!start||!Number.isFinite(width)||width<=0)return
   point={x:start.px+(x-start.x)*1000/width,y:start.py+(y-start.y)*1000/width}
   if(frame===null)frame=schedule(()=>{frame=null;const next=point;point=null;if(next)apply(next)})
  },
  end,
 }
}
