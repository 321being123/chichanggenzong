(function () {
  function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : ''; }
  function render(options) {
    var id=options.id,start=validDate(options.start),end=validDate(options.end),active=Number(options.activeYears)||0,presets=options.presets||[50,30,20,10,5,3];
    return '<div class="date-range-control" data-date-range="'+id+'"><strong>'+String(options.label||'选择时间')+'</strong>'+
      '<label>开始日期<input type="date" data-role="start" value="'+start+'"></label><label>结束日期<input type="date" data-role="end" value="'+end+'"></label>'+
      '<div class="date-range-presets">'+presets.map(function(n){return '<button type="button" data-years="'+n+'" class="'+(active===n?'is-active':'')+'">'+n+'年</button>';}).join('')+'</div></div>';
  }
  function bind(container, options) {
    var root=container.querySelector('[data-date-range="'+options.id+'"]');if(!root)return;
    var start=root.querySelector('[data-role="start"]'),end=root.querySelector('[data-role="end"]');
    function emit(activeYears){if(start.value&&end.value)options.onChange({start:start.value,end:end.value,activeYears:activeYears||0});}
    start.addEventListener('change',function(){emit(0);});end.addEventListener('change',function(){emit(0);});
    Array.prototype.forEach.call(root.querySelectorAll('[data-years]'),function(button){button.addEventListener('click',function(){var years=Number(button.getAttribute('data-years')),endDate=end.value?new Date(end.value+'T00:00:00'):new Date(),startDate=new Date(endDate);startDate.setFullYear(startDate.getFullYear()-years);start.value=startDate.toISOString().slice(0,10);emit(years);});});
  }
  window.DateRangeControl={render:render,bind:bind};
})();
