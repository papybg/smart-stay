import axios from 'axios';
const clientId = 'bb7b00e0-99d8-4c35-b551-c42d3a117b62';
const clientSecret = '9363aaa8-e710-4128-b852-05166865df77';
const refresh = 'd4770034-3c9f-468a-9c01-551f84b44bc6';
(async()=>{
 try{
   const basic = Buffer.from(clientId+':'+clientSecret).toString('base64');
   const resp = await axios.post('https://api.smartthings.com/oauth/token',
     new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh}).toString(),
     {headers:{'Authorization':'Basic '+basic,'Content-Type':'application/x-www-form-urlencoded'}}
   );
   console.log('REFRESH RESPONSE',resp.data);
 } catch(e){
   console.error('REFRESH ERROR',e.response?.data || e.message);
 }
})();
