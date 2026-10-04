import { validateChatText, mergeConversation, CHAT_MAX_LENGTH } from './conversation-model.js';

export class ConversationPanel {
  constructor({ primaryOpen, onOpen, getPlayerId }) {
    this.primaryOpen=primaryOpen;this.onOpen=onOpen;this.getPlayerId=getPlayerId;
    this.dialog=document.querySelector('#conversation-dialog');
    this.history=document.querySelector('#conversation-history');
    this.preview=document.querySelector('#conversation-preview');
    this.input=document.querySelector('#chat-input');
    this.form=document.querySelector('#chat-form');
    this.status=document.querySelector('#chat-connection');
    this.sendButton=document.querySelector('#chat-send');
    this.newButton=document.querySelector('#conversation-new');
    this.unreadLabel=document.querySelector('#conversation-unread');
    this.entries=[];this.unread=0;this.serial=0;this.active=false;this.ready=false;
    this.preview.addEventListener('click',()=>this.open());
    document.querySelector('#conversation-close').addEventListener('click',()=>this.dialog.close());
    this.form.addEventListener('submit',event=>{event.preventDefault();if(!this.composing)this.submit();});
    this.input.addEventListener('compositionstart',()=>{this.composing=true;});
    this.input.addEventListener('compositionend',()=>{setTimeout(()=>{this.composing=false;},0);});
    this.input.addEventListener('keydown',event=>{
      if(event.key!=='Enter'||event.isComposing||this.composing||event.keyCode===229)return;
      event.preventDefault();if(!event.shiftKey)this.form.requestSubmit();
    });
    this.input.addEventListener('input',()=>this.updateStatus());
    this.newButton.addEventListener('click',()=>this.toBottom());
    this.history.addEventListener('scroll',()=>{if(this.atBottom()){this.unread=0;this.updateUnread();}});
    this.dialog.addEventListener('close',()=>{this.input.blur();});
    const viewport=()=>this.updateViewport();
    window.visualViewport?.addEventListener('resize',viewport);
    window.visualViewport?.addEventListener('scroll',viewport);
    window.addEventListener('resize',viewport);
    this.updateStatus();this.render(true);
  }
  start(epoch,session,startedAt) {
    const changed=this.epoch!==epoch||this.session?.code!==session?.code;
    this.stop(false);this.epoch=epoch;this.session={...session};this.startedAt=startedAt;this.active=true;
    if(changed){this.entries=[];this.pending=null;this.input.value='';this.unread=0;this.render(true);}
    this.connect();
  }
  stop(clear=false) {
    this.active=false;this.ready=false;clearTimeout(this.retry);clearTimeout(this.pendingTimer);
    const old=this.socket;this.socket=null;old?.close();
    if(clear){this.epoch=null;this.entries=[];this.pending=null;this.input.value='';this.unread=0;this.dialog.close();this.render(true);}
    this.updateStatus();
  }
  connect() {
    clearTimeout(this.retry);
    if(!this.active||!this.primaryOpen())return;
    const ws=this.socket=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws/chat`);
    this.awaitingHistory=true;
    this.updateStatus();
    ws.onmessage=event=>{
      if(ws!==this.socket)return;
      let msg;try{msg=JSON.parse(event.data);}catch{return;}
      if(msg.type==='chat_hello'){ws.send(JSON.stringify({type:'bind_chat',...this.session}));return;}
      if(msg.type==='chat_rejected'){this.active=false;this.status.textContent='聊天会话失效，请重新加入战区';return;}
      if(msg.roomEpoch!==undefined&&msg.roomEpoch!==this.epoch)return;
      if(msg.type==='chat_ready'){this.ready=true;this.updateStatus();return;}
      if(msg.type==='conversation'){
        const previous=new Set(this.entries.map(entry=>entry.sequence));
        this.startedAt=msg.startedAt;
        const added=msg.entries.filter(entry=>entry.kind==='chat'&&!previous.has(entry.sequence));
        const follow=this.dialog.open&&this.atBottom();
        this.entries=mergeConversation(this.entries,msg.entries,msg.reset);
        if(!msg.reset&&!follow)this.unread+=added.length;
        if(this.pending&&this.entries.some(entry=>entry.kind==='chat'&&entry.playerId===this.getPlayerId()&&entry.requestId===this.pending.requestId))this.confirm(this.pending.requestId);
        this.render(follow);
        // Retry the same request only after history recovery; the server deduplicates it.
        if(this.pending&&this.awaitingHistory)this.transmit();
        this.awaitingHistory=false;
      } else if(msg.type==='chat_sent')this.confirm(msg.requestId);
      else if(msg.type==='chat_error'){
        if(!msg.requestId||msg.requestId===this.pending?.requestId){this.pending=null;clearTimeout(this.pendingTimer);}
        this.updateStatus(msg.message);
      }
    };
    ws.onclose=()=>{
      if(ws!==this.socket)return;
      this.ready=false;clearTimeout(this.pendingTimer);this.updateStatus();
      if(this.active&&this.primaryOpen())this.retry=setTimeout(()=>this.connect(),1500);
    };
    ws.onerror=()=>{};
  }
  submit() {
    if(this.pending)return;
    let text;try{text=validateChatText(this.input.value);}catch(error){this.updateStatus(error.message);return;}
    if(!this.ready||this.socket?.readyState!==WebSocket.OPEN){this.updateStatus('聊天连接中，草稿已保留');return;}
    this.pending={text,requestId:`${Date.now().toString(36)}-${++this.serial}`};
    if(this.transmit())this.updateStatus();
  }
  transmit() {
    if(!this.pending||!this.ready||this.socket?.readyState!==WebSocket.OPEN)return;
    if(this.socket.bufferedAmount>16384){this.pending=null;this.updateStatus('网络繁忙，草稿已保留');return false;}
    this.socket.send(JSON.stringify({type:'chat_send',...this.pending}));
    clearTimeout(this.pendingTimer);
    this.pendingTimer=setTimeout(()=>{if(this.pending)this.socket?.close();},8000);
    return true;
  }
  confirm(requestId) {
    if(this.pending?.requestId!==requestId)return;
    if(this.input.value.trim()===this.pending.text)this.input.value='';
    this.pending=null;clearTimeout(this.pendingTimer);this.updateStatus();
  }
  updateStatus(message) {
    this.status.textContent=message||(this.pending?'正在发送…':this.ready?'已连接 · 房间全员可见':this.active||this.epoch!=null?'聊天连接中 · 草稿已保留':'尚未进入战区');
    this.sendButton.disabled=!this.ready||!!this.pending||!this.input.value.trim();
    document.querySelector('#chat-count').textContent=`${this.input.value.length} / ${CHAT_MAX_LENGTH}`;
  }
  updateViewport() {
    const viewport=window.visualViewport;
    this.dialog.style.setProperty('--conversation-top',`${viewport?.offsetTop??0}px`);
    this.dialog.style.setProperty('--conversation-left',`${viewport?.offsetLeft??0}px`);
    this.dialog.style.setProperty('--conversation-height',`${viewport?.height??window.innerHeight}px`);
    this.dialog.style.setProperty('--conversation-width',`${viewport?.width??window.innerWidth}px`);
  }
  open() {
    if(!this.active)return;
    this.onOpen();this.updateViewport();
    if(!this.dialog.open)this.dialog.showModal();
    this.toBottom();
    const focusTarget=matchMedia('(max-width:760px), (pointer:coarse)').matches?this.history:this.input;
    focusTarget.focus({preventScroll:true});
  }
  atBottom() {return this.history.scrollHeight-this.history.clientHeight-this.history.scrollTop<40;}
  toBottom() {this.history.scrollTop=this.history.scrollHeight;this.unread=0;this.updateUnread();}
  updateUnread() {
    this.unreadLabel.hidden=!this.unread;this.unreadLabel.textContent=this.unread?`+${this.unread}`:'';
    this.newButton.hidden=!this.unread||!this.dialog.open;
    this.newButton.textContent=`${this.unread} 条新消息 ↓`;
  }
  record(entry,compact=false) {
    const row=document.createElement(compact?'span':'article');
    row.className=`conversation-record ${entry.kind}${entry.kind==='chat'&&entry.playerId===this.getPlayerId()?' own':''}`;
    row.dataset.sequence=entry.sequence;
    row.style.setProperty('--speaker-color',`var(--faction-${entry.playerId},var(--muted))`);
    const name=document.createElement('b');name.textContent=entry.name;
    const text=document.createElement('span');text.className='conversation-text';text.textContent=entry.text;
    row.append(name,compact?document.createTextNode(entry.text):text);return row;
  }
  render(follow=false) {
    const anchor=[...this.history.children].find(el=>el.getBoundingClientRect().bottom>this.history.getBoundingClientRect().top);
    const anchorSequence=anchor?.dataset.sequence,anchorTop=anchor?.getBoundingClientRect().top;
    const oldScroll=this.history.scrollTop;
    this.preview.replaceChildren();
    if(!this.entries.length){const text=document.createElement('span');text.className='conversation-empty';text.textContent='点击这里或按 Enter，打开聊天';this.preview.append(text);}
    else for(const entry of this.entries.slice(-4))this.preview.append(this.record(entry,true));
    this.history.replaceChildren();
    if(!this.entries.length){const text=document.createElement('p');text.className='conversation-empty';text.textContent='暂无消息，与房间里的指挥官聊聊吧。';this.history.append(text);}
    else for(const entry of this.entries)this.history.append(this.record(entry));
    if(follow)this.toBottom();
    else if(anchorSequence){const next=[...this.history.children].find(el=>el.dataset.sequence===anchorSequence);this.history.scrollTop=oldScroll+(next?next.getBoundingClientRect().top-anchorTop:0);}
    this.updateUnread();
  }
}
