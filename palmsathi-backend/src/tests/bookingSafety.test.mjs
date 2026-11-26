import mongoose from "mongoose";
import assert, { AssertionError } from "node:assert/strict";
import Mill from "../models/Mill.js";
import HarvestBatch from "../models/HarvestBatch.js";
import Booking from "../models/Booking.js";
import { confirmBooking } from "../services/bookingReservation.js";

await mongoose.connect("mongodb://127.0.0.1:27017/palmsthi_booking_test");

let mill;
let batches = [];

try{
  await Booking.createIndexes();
  const slotTime = new Date(Date.now()+3600000);

  mill = await Mill.create({
    name:"Test Mill",
    location:{lat:16.9,lng:81.7},
    dailyCapacityKg:500,
    todayOfferedPricePerKg:20,
    govtMinPricePerKg:18,
    slots:[{slotTime,capacityKg:500,remainingKg:500}]
  });

  batches = await HarvestBatch.create([400,400,600].map(quantityKg => ({
    plotId:new mongoose.Types.ObjectId(),
    farmerId:new mongoose.Types.ObjectId(),
    quantityKg,
    harvestedAt:new Date()
  })));

  const candidate = b => ({
    batchId:b._id.toString(),
    millId:mill._id.toString(),
    slotId:mill.slots[0]._id.toString(),
    slotTime,
    quantityKg:b.quantityKg,
    freshnessAtAssignment:90
  });

  const results = await Promise.all(
    batches.slice(0,2).map(b=>
      confirmBooking(candidate(b))
    )
  );

  assert.deepEqual(
    results.map(r=>r.status).sort(),
    ["confirmed","insufficient_capacity"]
  );

  console.log("Pass 1:Only one overlapping booking succeeds");

  const latest = await Mill.findById(mill._id);
  assert.equal(latest.slots[0].remainingKg,100);
  console.log("PASS 2: Capacity decreased exactly once");

  const loser=batches[results.findIndex(r=>r.status!=="confirmed")];
  assert.equal((await
    HarvestBatch.findById(loser._id)).status,"pending"
  );
  console.log("Pass 3: Failed batch remains pending");

  const winner = batches[results.findIndex(r=>r.status === "confirmed")];

  const repeat = await confirmBooking(candidate(winner));
  assert.equal(repeat.status,"already_booked");
  console.log("Pass 4: Duplicate booking prevented");

  const oversized = await
  confirmBooking(candidate(batches[2]));
  assert.equal(oversized.status,"insufficient_capacity");

  assert.equal(
    await Booking.countDocuments({
      batchId:{$in:batches.map(b=>b._id)}
    }),
    1
  );

  assert.equal(
    (await Mill.findById(mill._id)).slots[0].remainingKg,
    100
  );

  assert.equal(
    (await HarvestBatch.findById(batches[2]._id)).status,"pending"
  );

  console.log("Pass 5: Insuffient capacity rejected safely");
  console.log("\nALL 5 Booking Safety Tests Passed");

}finally{
  const ids = batches.map(b=>b._id);

  if(ids.length){
    await Booking.deleteMany({batchId:{$in:ids}});
    await HarvestBatch.deleteMany({_id:{$in:ids}});
  }
  if(mill) await Mill.deleteOne({_id:mill._id});
  await mongoose.disconnect();
}