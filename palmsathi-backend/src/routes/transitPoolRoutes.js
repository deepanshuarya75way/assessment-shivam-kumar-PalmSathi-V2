import {Router} from "express";
import {protect} from "../middleware/auth.js";
import TransitPool from "../models/TransitPool.js";
import Booking from "../models/Booking.js";
import HarvestBatch from "../models/HarvestBatch.js";
import {distanceKm} from "../utils/geo.js";

import {
  check,same,total,nearby,units,point,plan,checkArrival,addMember, dispatch
} from "../services/transitPlanner.js";

const router = Router();
router.use(protect);

const clients = new Set();

router.get("/events",(req,res)=>{
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering":"no"
  });
  res.flushHeaders();
  clients.add(res);
  res.write("data:ready\n\n");

  const timer = setTimeout(()=> res.end(),300000);

  res.on("close", () => {
    clearTimeout(timer);
    clients.delete(res);
  });
});

function notify(){
  for(const res of clients)
    if(!res.writableEnded)
      res.write("data: changed\n\n");
}

const run = fn => async (req,res) => {
  try{
    await fn(req,res);
  }
  catch(e){
    const status = e.status || (e.code === 11000 || e.name === "VersionError"?409 :
      e.name === "CastError" || e.name === "ValidationError"?400:500
    );
    res.status(status).json
    ({
      error:status === 500 ? "Transit request failed":
      status === 409 && !e.status ? "Pool changed or batch already reserved. Retry.": e.message
    });
  }
};

let indexes;
 const ready = () => indexes ??= TransitPool.createIndexes().catch(e =>{
  indexes = null;
  throw e;
 });

 const populate = [
  {path: "batchId",populate: {path: "plotId"}},
  {path: "millId"}
 ];

 function candidate(b,farmer,pickup){
  const h = b?.batchId;
  const plot = h?.plotId;

  check(h && plot && b.millId && same(h.farmerId,farmer.id) && same(plot.farmerId,farmer.id),"Booking not found", 404);

  check(b.status === "confirmed" && h.status === "assigned" && b.slotTime > new Date(),"Choose an active confirmed booking", 409);
  const grams = units(h.quantityKg,1000,50000000);
  
  check(grams === units(b.quantityKg,1000,50000000),"Booking weight mismatch",409);
  
  const location = point(pickup ?? plot.location);
  check(distanceKm(location,point(plot.location))<=5,"Pickup must be near your plot");

  return {
    batchId : h._id,
    farmerId: h.farmerId,
    name: farmer.name || "Farmer",
    grams,
    pickup: location,
    slotTime: b.slotTime
  };
 }

 function view(p,id){
  const stops = plan(p);
  return {
    id:p._id,
    millId:p.millId,
    millName:p.millName,
    remaining:(p.capacity-total(p))/1000,
    freight:p.freight/100,
    status:p.status === "open" && 
    p.departureAt<=new Date() ? "expired" :
    p.status,
    mine:p.members.some(m=>same(m.farmerId,id)),
    owner:same(p.members[0].farmerId,id),
    stops,
    late: +stops.at(-1).end>Math.min(...p.members.map(m=> +m.slotTime)),
    arrivedAt:p.arrivedAt
 };
 }

 router.get("/",run(async(req,res)=>{
  const ids = await HarvestBatch.find({
    farmerId:req.farmer.id,
    status:"assigned"
  }).distinct("_id");

  const bookings = await Booking.find({
    batchId:{$in:ids},
    status:"confirmed",
    slotTime:{$gt:new Date()}
  }).populate(populate).lean();

  const options = [];
  console.log("assigned batches:",ids.length);
  console.log("eligible bookings:",bookings.length);
  
  
  for(const b of bookings){
    try{
      const m = candidate(b,req.farmer);

      options.push({
        id:b._id,
        batchId:m.batchId,
        millId:b.millId._id,
        millName:b.millId.name,
        kg:m.grams/1000,
        slotTime:b.slotTime,
        pickup:m.pickup
      });
    }catch(e){
      console.log("rejected",e.message);
      if(!e.status) throw e;
    }
  }

  const pools = await TransitPool.find({
    $or:[
      {"members.farmerId":req.farmer.id},
      {
        status:"open",
        departureAt:{$gt:new Date()},
        millId:{$in:options.map(b=>b.millId)}
      }
    ]
  }).lean();

  const mine = pools.filter(p => p.members.some(m => same(m.farmerId,req.farmer.id)));

  const free = options.filter(b=>!mine.some(p=>p.members.some(m=>same(m.batchId,b.batchId))));

  res.json({
    bookings:free,
    pools:pools.filter(p=>mine.includes(p)||free.some(b=>same(b.millId,p.millId)
    &&nearby(b.pickup,p.members[0].pickup))).map(p=>view(p,req.farmer.id))
  });
 }));

 router.post(["/","/:id/join"],run(async(req,res)=>{
    await ready();
    const b = await
    Booking.findById(req.body.bookingId).populate(populate).lean();

    const m = candidate(b,req.farmer,req.body.pickup);

    let p;

    if(req.params.id){
      p = await TransitPool.findById(req.params.id);
      check(p,"Pool not found",404);

      if(p.members.some(x => same(x.batchId,m.batchId))) return res.json(view(p,req.farmer.id));

      addMember(p,m,b.millId._id);
    }else{
      p = new TransitPool({
        millId: b.millId._id,
        millName: b.millId.name,
        millLocation: point(b.millId.location),
        capacity: units(req.body.capacityKg, 1000, 50000000),
        freight: units(req.body.freightRupees, 100, 100000000),
        departureAt: new Date(req.body.departureAt),
        members: [m]
      });
      check(p.departureAt > new Date() && p.capacity >= m.grams, "Invalid departure or capacity");
      checkArrival(p);
    }

    await p.save();

    notify();
    res.json(view(p,req.farmer.id));

  }));

  router.patch("/:id/status", run(async(req,res)=> {
    const p = await
    TransitPool.findById(req.params.id);
    check(p,"Pool not found", 404);

    dispatch(p,req.farmer.id, req.body.action, req.body.batchId);
    await p.save();
    notify();
    res.json(view(p,req.farmer.id));
  }));

  router.delete("/:id",run(async (req,res)=>{
    const p = await
    TransitPool.findById(req.params.id);
    check(p && same(p.members[0].farmerId, req.farmer.id), "Organizer only",403);
    check(p.status === "open", "Already dispatched",409);

    const result = await TransitPool.deleteOne({
      _id: p._id,
      __v: p.__v,
      status: "open"
    });
    check(result.deletedCount === 1, "Pool changed. Retry.", 409);
    notify();
    res.json({ok: true});
  }));

  export default router;