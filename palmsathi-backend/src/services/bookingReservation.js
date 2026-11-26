import mongoose from "mongoose";
import HarvestBatch from "../models/HarvestBatch.js";
import Mill from "../models/Mill.js";
import Booking from "../models/Booking.js";

export async function confirmBooking(candidate){
  const{
    batchId,
    millId,
    slotId,
    slotTime,
    freshnessAtAssignment,
  } = candidate;

  let capacityReserved = false;
  let batchMarkedAssignment = false;
  let booking = null;
  let quantityKg = 0;
  try{
        const existing = await Booking.findOne({batchId});

        if(existing){
          return {
            status:"already_booked",
            booking:existing,
          };
        }

        const batch = await HarvestBatch.findOne({
          _id:batchId,
          status:"pending",
        });

        if(!batch){
          return {status:"batch_not_pending"};
        }

        quantityKg = batch.quantityKg;

        if(!Number.isFinite(quantityKg) || quantityKg <= 0){
          return {status:"invalid_quantity"};
        }

        const reserved = await Mill.updateOne({
          _id:millId,
          slots:{
            $elemMatch:{
              _id:slotId,
              remainingKg:{$gte:quantityKg},
            },
          },
        },{
          $inc:{
            "slots.$.remainingKg": -quantityKg,
            },
          });

          if(reserved.modifiedCount != 1){
            return{
              status:"insufficient_capacity",
            };
          }
          capacityReserved = true;

          const updatedBatch = await HarvestBatch.updateOne({
            _id:batchId,
            status:"pending",
          },
          {
            $set:{status:"assigned"},
          }
        );

        if(updatedBatch.modifiedCount != 1){
          throw new Error(
            "Batch status changed during reservation"
          );
        }
        batchMarkedAssignment = true;
        booking = await Booking.create({
              batchId,
              millId,
              slotId,
              slotTime,
              quantityKg,
              freshnessAtAssignment    
        });

        return {
          status:"confirmed",
          booking,
          farmerId:batch.farmerId.toString(),
        };
  }catch(error){
    try{
      if(booking){
        await Booking.deleteOne({_id:booking._id});
      }

      if(batchMarkedAssignment){
        await HarvestBatch.updateOne({
          _id:batchId,status:"assigned"
        },{$set:{status:"pending"}});
      }
      if(capacityReserved){
        await Mill.updateOne({
          _id:millId,"slots_id":slotId,
        },{
          $inc:{
            "slots.$.remainingKg":quantityKg,
          }
        })
      }
    }catch(rollbackError){
      console.error("Booking cleanup failed:", rollbackError);
      throw rollbackError;
    }
    if(error.code === 11000){
      const existing = await Booking.findOne({batchId});

      if(existing){
        return {
          status:"already_booked",
          booking:existing,
        };
      }
    }
    throw error;
  }
}