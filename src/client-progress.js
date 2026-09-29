// Advisory telemetry only. Never drives simulation, authority or history eviction.
export function acceptClientProgress(ws,room,msg,now=Date.now()) {
  if(!room?.game||!ws.member||ws.member.ws!==ws||msg.roomEpoch!==room.epoch)return null;
  if(ws.lastProgressAt!==undefined&&now-ws.lastProgressAt<250)return null;
  const {received,displayed,queueDepth,oldestMs,decodeMs,applyMs}=msg;
  if(!Number.isInteger(ws.sentGeneration)||!Number.isInteger(received)||received<0||received>ws.sentGeneration||
    !Number.isInteger(displayed)||displayed< -1||displayed>received||
    !Number.isInteger(queueDepth)||queueDepth<0||queueDepth>32)return null;
  if(![oldestMs,decodeMs,applyMs].every(n=>Number.isFinite(n)&&n>=0&&n<=60000))return null;
  const previous=ws.clientProgress;
  if(previous?.roomEpoch===room.epoch&&(received<previous.received||displayed<previous.displayed))return null;
  ws.lastProgressAt=now;
  return ws.clientProgress={roomEpoch:room.epoch,received,displayed,queueDepth,oldestMs,decodeMs,applyMs,at:now};
}
