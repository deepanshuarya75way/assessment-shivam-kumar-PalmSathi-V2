import { distanceKm } from "../utils/geo.js";

export function check(ok,message,status=400){
  if(!ok) throw Object.assign(new Error(message),{status});
}

export const same = (a,b)=>String(a)===String(b);
export const total = p => p.members.reduce((n,m)=>n+m.grams,0);
export const nearby = (a,b) => distanceKm(a,b) <= 25;

export function units(value,scale,max){
  const n = Number(value)*scale;
  const rounded = Math.round(n);

  check(
    ["number","string"].includes(typeof value) &&
    rounded > 0 && rounded <= max &&
    Math.abs(n-rounded) < 1e-5,
    "Invalid weight or freight"
  );

  return rounded;
}

export function point(p){
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);

  check(
    ["number","string"].includes(typeof p?.lat)&&
  ["number","string"].includes(typeof p?.lng) &&
  String(p.lat).trim() && String(p.lng).trim() &&
  Math.abs(lat) <= 90 && Math.abs(lng) <= 180,
  "Invalid coordinates"
  );

  return {lat,lng};
}


export function plan(p){
  const order = [p.members[0]];
  const left = p.members.slice(1);
  const sum = total(p);

  while(left.length){
    const last = order.at(-1).pickup;
    let best = 0;

    for(let i = 1; i < left.length; i++)
      if(distanceKm(last,left[i].pickup)<distanceKm(last,left[best].pickup)) best = i

    order.push(left.splice(best,1)[0]);
  }

  let time = +new Date(p.departureAt);
  let prev = order[0].pickup;

  let weight = 0, paid = 0;

  const stops = order.map(m=>{
    time += Math.ceil(distanceKm(prev,m.pickup)*60/25)*60000;
    
    weight += m.grams;
    const cumulative = Math.round(p.freight*weight/sum);
    
    const fee = (cumulative-paid)/100;
    paid = cumulative;
    
    const stop = {
      id:String(m.batchId),
      name:m.name,
      ...point(m.pickup),
      kg:m.grams/1000,
      fee,
      savings:(p.freight-Math.round(fee*100))/100,
      picked:m.pickedUpAt,
      eta:new Date(time),
      end:new Date(time+600000)
    };

    time = Math.max(time,+(m.pickedUpAt||0))+600000;
    prev = m.pickup;
    return stop;
  });

  time += Math.ceil(
    distanceKm(prev,p.millLocation)*60/25
  )*60000;

  stops.push({
    id:"mill",
    name:p.millName,
    ...point(p.millLocation),
    eta:new Date(time),
    end:new Date(time+600000)
  });

  return stops;
}

export function checkArrival(p){
  check(
    +plan(p).at(-1).end <= 
    Math.min(...p.members.map(m => +new Date(m.slotTime))),
    "Truck would miss a mill slot",409
  );
}

export function addMember(p,m,millId,now = new Date()){
  check(p.status === "open" && p.departureAt > now,"Pool is closed", 409);
  check(same(p.millId,millId) && 
nearby(p.members[0].pickup,m.pickup),"Different mill or pickup cluster",409);

check(!p.members.some(x => same(x.farmerId,m.farmerId)),"Already in pool",409);

check(p.members.length < 30 && total(p)+m.grams <= p.capacity, "Truck capcatiy exceeded",409);

checkArrival({
  members: [...p.members,m],
  millLocation: p.millLocation,
  departureAt: p.departureAt,
  freight: p.freight
});

p.members.push(m);
}

export function dispatch (p,farmerId,action,batchId, now = new Date()){
  check(same(p.members[0].farmerId,farmerId),"Organizer only.",403);
  if(action == "start"){
    check(p.status === "open","Already Dispatched",409);
    checkArrival({
      members: p.members,
      millLocation: p.millLocation,
      departureAt : now,
      freight: p.freight
    });
    p.departureAt = now;
    p.status = "in_transit";
  }
  else{
    check(p.status === "in_transit",
      "Truck is not in transit",409
    );
    const next = plan(p).find(s=> s.id !== "mill" && !s.picked);
    if(action === "pickup"){
      check(next && same(next.id, batchId),
      "Complete the next pickup first", 409);
      p.members.find(m=>same(m.batchId,batchId)).pickedUpAt = now;
    }
    else{
      check(action === "arrive" && !next, "Complete all pickups first",409);
      p.status = "arrived";
      p.arrivedAt = now;
    }
  }
}