import mongoose from "mongoose";

const {Schema} = mongoose;
const id = Schema.Types.ObjectId;

const point = new Schema({
  lat:Number,
  lng:Number,
},{_id:false});

const member = new Schema({
  batchId:{type:id,required:true},
  farmerId:id,
  name:String,
  grams:Number,
  pickup:point,
  slotTime:Date,
  pickedUpAt:{type:Date,default:null}
},{_id:false});

const schema = new Schema({
  millId:id,
  millName:String,
  millLocation:point,
  capacity:Number,
  freight:Number,
  departureAt:Date,
  members:[member],
  arrivedAt:Date,
  status:{
    type:String,
    enum:["open","in_transit","arrived"],
    default:"open"
  }
},{
  timestamps:true,
  optimisticConcurrency:true
});

schema.index({"members.batchId":1},{unique:true});
schema.index({millId:1,status:1});

export default mongoose.model("TransitPool",schema);