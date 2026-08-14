<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,minimum-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#000;width:100vw;height:100vh;overflow:hidden}
#player{width:100%;height:100%}
.info{position:absolute;bottom:20px;left:0;right:0;text-align:center;color:#999;font-size:13px;font-family:sans-serif;pointer-events:none;z-index:999}
</style>
</head><body>
<div id="player"></div>
<div class="info" id="info">初始化中...</div>
<script src="https://cdn.jsdelivr.net/npm/ezuikit-js/ezuikit.js"></script>
<script>
var info = document.getElementById('info');
info.textContent='连接中...';
var player;
function initPlayer(){
  info.textContent='连接中...';
  try {
    player = new EZUIKit.EZUIKitPlayer({
      id:'player',
      accessToken:'{{ $token }}',
      url:'ezopen://open.ys7.com/{{ $serial }}/1.live',
      template:'simple',
      scaleMode:1,
      audio:true,
      staticPath:'https://cdn.jsdelivr.net/npm/ezuikit-js/ezuikit_static',
      handleSuccess:function(){info.textContent='';},
      handleError:function(e){
        var det = '';
        if(e && typeof e === 'object'){
          det = 'type=' + (e.type||'') + ' errCode=' + (e.errorCode||e.code||'?');
          if(e.data) for(var k in e.data) det += ' ' + k + '=' + e.data[k];
          if(e.message) det += ' msg=' + e.message;
          if(e.nErrorCode === 5) det += ' ENCRYPTED';
        } else {
          det = String(e);
        }
        info.textContent = det ? '播放失败: ' + det : '播放失败';
      }
    });
  } catch(e){
    info.textContent='播放器初始化失败: '+e.message;
  }
}
setTimeout(initPlayer, 500);
</script>
</body></html>
