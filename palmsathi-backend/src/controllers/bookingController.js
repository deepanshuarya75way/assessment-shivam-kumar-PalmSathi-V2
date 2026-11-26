import HarvestBatch from "../models/HarvestBatch.js";
import Mill from "../models/Mill.js";
import Booking from "../models/Booking.js";
import { runMatching } from "../services/matchingEngine.js";
import { confirmBooking } from "../services/bookingReservation.js";
import { awardPoints } from "../services/walletService.js";

const ENGINE_OPTIONS = {
  minFreshnessThreshold: Number(process.env.MIN_FRESHNESS_THRESHOLD || 70),
  decayRateWeight: Number(process.env.DECAY_RATE_WEIGHT || 1.5),
  travelWeight: Number(process.env.TRAVEL_WEIGHT || 0.5),
};

export async function runMatchingPass(req, res) {
  try {
    const pendingBatches = await HarvestBatch.find({ status: "pending" }).populate("plotId");
    const validBatches = pendingBatches.filter(b => b.plotId !== null);
    const mills = await Mill.find();

    if (validBatches.length === 0) {
      return res.json({ assignments: [], unassigned: [], message: "No pending batches." });
    }

    const batchInput = validBatches.map((b) => ({
      id: b._id.toString(),
      quantityKg: b.quantityKg,
      harvestedAt: b.harvestedAt,
      plotLocation: b.plotId.location,
    }));

    const millInput = mills.map((m) => ({
      id: m._id.toString(),
      location: m.location,
      slots: m.slots
        .filter((s) => s.remainingKg > 0)
        .map((s) => ({ id: s._id.toString(), slotTime: s.slotTime, remainingKg: s.remainingKg })),
    }));

    const { assignments, unassigned } = runMatching(batchInput, millInput, ENGINE_OPTIONS);

    const savedBookings = [];
    const failedBookings = [];
    for (const a of assignments) {
      try{
        const result = await confirmBooking(a);

        if(result.status === "confirmed"){
          savedBookings.push(result.booking);
          
          if(a.freshnessAtAssignment >= 85){
            try{
              await awardPoints(
                result.farmerId,
                30,
                "Booked mill slot with freshnedd above 85"
              );
            }catch(error){
              console.error("Wallet reward failed",
                error.message
              );
            }
          }}else if(result.status!="already_booked"){
            failedBookings.push({
              batchId:a.batchId,
              reason:result.status, 
            });
        }
      }catch(error){
        console.error("Booking failed:",error.message);

        failedBookings.push({
          batchId:a.batchId,
          reason:"reservation_failed",
        });
      }
    }

    for (const u of unassigned) {
      await HarvestBatch.updateOne(
        {
          _id:u.batchId,
          status:"pending",
        },{
          $set:{status:"unassigned_emergency"},
        }
      );
    }

    const finalUnassigned = {...unassigned, ...failedBookings};

    const io = req.app.get("io");
    if (io) {
      io.emit("matchingPassComplete", {
        assignmentsCount: savedBookings.length,
        unassignedCount: finalUnassigned.length,
        bookings: savedBookings,
        unassigned:finalUnassigned,
      });
    }

    res.json({ assignments: savedBookings, unassigned:finalUnassigned });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function listBookings(req, res) {
  const bookings = await Booking.find({})
    .populate({ path: "batchId", populate: { path: "plotId" } })
    .populate("millId");

  // Filter to only show bookings belonging to the logged-in farmer
  const myBookings = bookings.filter(b =>
    b.batchId?.farmerId?.toString() === req.farmer.id
  );

  res.json(myBookings);
}