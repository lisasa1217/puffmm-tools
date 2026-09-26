/* 像素風工具箱：精靈圖 (sprites) 渲染器
   用法：<i data-px="star"></i>，寬度用 CSS 控制（例如 .px-s{width:32px}）。
   每個精靈是字串陣列，一個字元 = 一顆像素，顏色見 PAL。 */
(function(){
  var PAL = {
    o:'#6a5153', y:'#ffd96b', Y:'#fff0b0', p:'#f3a9c0', P:'#fbd6e2',
    t:'#8fd1c0', T:'#cdeee5', b:'#93b1ee', B:'#cfdcf9', w:'#fffdf4',
    r:'#ec7f84', g:'#8fd39a', n:'#deae86', c:'#c5dcf2', W:'#ffffff'
  };
  var SPRITES = {"clip": ["......oooo......", ".....otttto.....", "..oooottttoooo..", "..owwwwwwwwwwo..", "..owppppppppwo..", "..owwwwwwwwwwo..", "..owppppppwwwo..", "..owwwwwwwwwwo..", "..owppppppppwo..", "..owwwwwwwwwwo..", "..owpppppwwwwo..", "..owwwwwwwwwwo..", "..owbbbbwwwwwo..", "..owwwwwwwwwwo..", "..oooooooooooo..", "................"], "link": ["................", "................", "................", "................", "...oooo..oooo...", "..TbbbboopPppo..", ".obbooboppooppo.", ".obo..oopo..opo.", ".obo..oopo..opo.", ".obbooboppooppo.", "..obbbbooppppo..", "...oooo..oooo...", "................", "................", "................", "................"], "gift": ["................", ".....ooo..ooo...", "....oPPPooPPPo..", "....oPppooppPo..", ".....oooppooo...", "..oooooooppoooo.", "..oPPPPPoppPPPo.", "..oPrrrrrpprrro.", "..oooooooppoooo.", "...oYYYYoppYYo..", "...oYYYYoppYYo..", "...oYyyyoppyyo..", "...oYYYYoppYYo..", "...oyyyyoppyyo..", "...oooooooooooo.", "................"], "heart": ["................", "................", "..oooo....oooo..", ".orrrPo..orrrro.", "orrPrrroorrrrrro", "orPrrrrrrrrrrrro", "orrrrrrrrrrrrrro", "orrrrrrrrrrrrrro", ".orrrrrrrrrrrro.", "..orrrrrrrrrro..", "...orrrrrrrro...", "....orrrrrro....", ".....orrrro.....", "......orro......", ".......oo.......", "................"], "star": ["................", ".......oo.......", ".......oo.......", "......oyyo......", "......oyyo......", ".....oyyyyo.....", "..oooyyyyyyooo..", "ooyyyyyyyyyyyyoo", "ooyyyyyyyyyyyyoo", "..oooyyyyyyooo..", ".....oyyyyo.....", "......oyyo......", "......oyyo......", ".......oo.......", ".......oo.......", "................"], "bear": ["................", "..ooo......ooo..", ".onnnooooooonnno", ".onPnnnnnnnnPno.", "onnnnnnnnnnnnnno", "onnnonnnnnonnnno", "onnnnnnnnnnnnnno", "onnnnnYYYYnnnnno", "onnnnYYooYYnnnno", "onnnnnYYYYnnnnno", ".onnnnnnnnnnnno.", "..onnnnnnnnnno..", "...oooooooooo...", "................", "................", "................"], "coin": ["................", "................", ".....oooooo.....", "...ooyyyyyyoo...", "..oyyYYyyyyyyo..", "..oyYYyyoooyyo..", ".oyyYyyoyyyyyyo.", ".oyyyyyoyyyyyyo.", ".oyyyyyoyyyyyyo.", ".oyyyyyoyyyyyyo.", "..oyyyyoooyyyo..", "..oyyyyyyyyyyo..", "...ooyyyyyyoo...", ".....oooooo.....", "................", "................"], "cursor": ["oo..............", "owo.............", "owwo............", "owwwo...........", "owwwwo..........", "owwwwwo.........", "owwwwwwo........", "owwwwwwwo.......", "owwwwwwwwo......", "owwwwwooooo.....", "owwowwo.........", "owo.owwo........", "oo..owwo........", ".....owwo.......", "......oo........", "................"], "soon": ["................", ".oooooooooooooo.", ".oyYYYYYYYYYYyo.", ".oYYYYooooYYYYo.", ".oYYYooYYooYYYo.", ".oYYYooYYooYYYo.", ".oYYYYYYooYYYYo.", ".oYYYYYooYYYYYo.", ".oYYYYYooYYYYYo.", ".oYYYYYYYYYYYYo.", ".oYYYYYooYYYYYo.", ".oYYYYYYYYYYYYo.", ".oYYYYYYYYYYYYo.", ".oyYYYYYYYYYYyo.", ".oooooooooooooo.", "................"], "cloud": ["........cccccc..........", "......ccWWWWWWcc........", "....ccWWWWWWWWWWcccc....", "..ccWWWWWWWWWWWWWWWWcc..", ".cWWWWWWWWWWWWWWWWWWWWc.", "cWWWWWWWWWWWWWWWWWWWWWWc", "cWWWWWWWWWWWWWWWWWWWWWWc", ".cccccccccccccccccccccc."], "spark": ["...oo...", "...oo...", "..oyyo..", "ooyyyyoo", "ooyyyyoo", "..oyyo..", "...oo...", "...oo..."]};
  function svgFor(name){
    var rows = SPRITES[name]; if(!rows) return null;
    var h = rows.length, w = rows[0].length, rects = '';
    for(var y=0;y<h;y++){
      var x=0;
      while(x<w){
        var ch = rows[y][x];
        if(ch==='.'){ x++; continue; }
        var x2=x; while(x2<w && rows[y][x2]===ch) x2++;
        rects += '<rect x="'+x+'" y="'+y+'" width="'+(x2-x)+'" height="1" fill="'+PAL[ch]+'"/>';
        x = x2;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+w+' '+h+'" shape-rendering="crispEdges" width="100%" height="100%" aria-hidden="true">'+rects+'</svg>';
  }
  function hydrate(root){
    (root||document).querySelectorAll('[data-px]').forEach(function(el){
      if(el.getAttribute('data-px-done')) return;
      var s = svgFor(el.getAttribute('data-px'));
      if(s){ el.innerHTML = s; el.setAttribute('data-px-done','1'); }
    });
  }
  window.PX = { hydrate: hydrate, svg: svgFor, sprites: SPRITES };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', function(){ hydrate(); });
  else hydrate();
})();
