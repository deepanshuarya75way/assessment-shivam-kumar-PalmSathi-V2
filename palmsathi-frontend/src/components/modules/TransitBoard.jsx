import { useEffect,useState,useRef } from "react";
import API from "@/api/auth"
import {Button} from "@/components/ui/button";
import { Bus } from "lucide-react";

const url = "/transit-pools";
const time = t=> new Date(t).toLocaleTimeString();

function RouteMap({stops}){
  const [selected,setSelected] = useState(0);

  const minX = Math.min(...stops.map(s=>s.lng));
  const minY = Math.min(...stops.map(s => s.lat));

  const scale = Math.min(260/Math.max(...stops.map(s => s.lng-minX),0.00001),
  120/Math.max(...stops.map(s=>s.lat-minY),0.00001));

  const xy = s=>[
    20+(s.lng-minX)*scale,
    140-(s.lat-minY)*scale
  ];

  const active = stops[Math.min(selected,stops.length-1)];

  return <div>
    <svg viewBox="0 0 300 160"
    className = "w-full max-h-48 bg-green-50 rounded"
    >

      <polyline 
        points={stops.map(s=>xy(s).join(",")).join(" ")}
        fill="none" stroke="green" strokeWidth="2"
      />

      {stops.map((s,i)=>(
        <g key={s.id} onClick={()=>setSelected(i)}
        style={{cursor:"pointer"}}>
        <circle cx = {xy(s)[0]} cy={xy(s)[1]} r="9"
        fill={s.id === "mill"?"blue":"green"}/>
        <text x = {xy(s)[0]} y = {xy(s)[1]+3} fontSize="9" fill="white" textAnchor="middle">{i+1}</text>

        <title>{s.name}</title>
        </g>
      ))}
      </svg>

      <p className="text-xs"> Geographic preview, not road navigation</p>
      <p>{active.name}:{time(active.eta)}-{time(active.end)}(estimated)</p>
      </div>;
}

export default function TransitBoard() {
  const [data, setData] = useState({bookings:[], pools:[]});
  const [form, setForm] = useState({
    capacityKg: "1000",
    freightRupees: "1000",
    departureAt: ""
  });

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  async function load(){
    const n = ++seq.current;
    try {
      const {data } = await API.get(url);
      if( n === seq.current) setData(data);
    }
    catch(e) {
      if(n === seq.current)
        setError(e.response?.data?.error || "Unable to load pools");
    }
  }

  useEffect(() =>{
    const controller = new AbortController();
    load();
    const timer = setInterval(load, 4000);

    (async () => {
      try{
        const base = (API.defaults.baseURL || "/api").replace(/\/$/, "");
        const res = await fetch(base + url + "/events",{
          headers: {
            Authorization: "Bearer "+ localStorage.getItem("token")
          },
          signal : controller.signal
        });

        if(!res.ok) return;
        const reader = res.body.getReader();
        while(!(await reader.read()).done && !controller.signal.aborted) load();
      }
      catch{

      }
    })();
    return () => {
      controller.abort();
      clearInterval(timer);
      seq.current++;
    };
  },[]);

  const booking = data.bookings.find(b => b.id === form.bookingId) || data.bookings[0];
  const current = form.bookingId === booking?.id ? form : {};

  const pickup ={
    lat: current.lat ?? booking?.pickup.lat,
    lng: current.lng ?? booking?.pickup.lng
  };

  const change = (key, value) => setForm( f=> ({
    ...f,
    ...(f.bookingId != booking?.id ? {
      bookingId : booking?.id,
      lat: undefined,
      lng: undefined
    } : {}),
    [key] : value
  }));

  const body = {bookingId: booking?.id, pickup};
  async function act(fn){
    setBusy(true);
    setError("");

    try{
      await fn();
      await load();
    } catch (e){
      setError(e.response?.data?.error || e.message);
    }
    finally{
      setBusy(false);
    }
  }

  return <section className="space-y-4">
    <h2 className= "text-xl font-bold">Shared Transit Pooling</h2>
    {error && <p role ="alert" className="text-red-600"> {error}</p>}

    {booking ? <form className="border rounded p-4 grid gap-2"
      onSubmit={e=> {
        e.preventDefault();
        act(() => API.post(url,{
          ...form, ...body,
          departureAt: new Date(form.departureAt).toISOString()
        }));
      }}>
        
      <label>Confirmed booking
        <select className="border p-2" value={booking.id}
        onChange={e => setForm(f => ({
          ...f,
          bookingId: e.target.value,
          lat: undefined,
          lng: undefined
        }))}>
          {data.bookings.map(b =>
            <option key = {b.id} value = {b.id}>
              {b.kg} kg - {b.millName} - {new Date(b.slotTime).toLocaleString()}
            </option>
          )}
        </select>
      </label>
    {[
      ["lat", "Pickup latitude", pickup.lat],
      ["lng", "Pickup longitude", pickup.lng],
      ["capacityKg", "Truck capacity (kg)", form.capacityKg],
      ["freightRupees", "Truck fire (INR)", form.freightRupees]
    ].map(([key,label,value]) =>
    <label key = {key}>{label}
      <input className="border p-2" required
      type ="number" step= "any" value ={value ?? ""}
      onChange={e => change(key, e.target.value)} />
      </label>
    )}
    <label>First pickup
      <input className="border p-2" required
      type="datetime-local" value ={form.departureAt}
      onChange={e => change("departureAt", e.target.value)} />
    </label>

    <Button disabled ={busy}>Create pool</Button>
    </form> : <p>Reserve al mill slot in Harveste &amp; Booking first.</p>}

    {data.pools.map(p =>{
      const next = p.stops.find(s => s.id !== "mill" && !s.picked);
      const update = (action,batchId) => act(() =>
      API.patch(`${url}/${p.id}/status`, {action, batchId}));

      return <article key = {p.id}
      className="border rounded p-4 space-y-2">
        <h3 className="font-bold"> {p.millName} - {p.status}</h3>
        <p>{p.remaining} kg available | Truck hire: INR {p.freight}</p>
        <RouteMap stops = {p.stops} />

        {p.late && p.status !== "arrived" &&
        <p className="text-red-600">Risk of missing the mill slot</p>}
        {p.stops.filter(s => s.id !== "mill").map(s =>
          <p key = {s.id}>
            {s.name}: {s.kg} kg |
            Fee: INR {s.fee.toFixed(2)} |
            Save: INR {s.savings.toFixed((2))} |
            {p.status === "arrived" ? "At mill" :
            s.picked ? "Picked up" :"Waiting"}
            </p>
        )}

        {p.status === "open" && !p.mine && booking?.millId === p.millId && booking.kg <= p.remaining && 
        <Button disabled={busy} onClick={() =>
          act(() => API.post(`${url}/${p.id}/join`, body))}>
            Join Pool
          </Button>}
        
        {p.owner && ["open", "expired"].includes(p.status) && <>
          <Button disabled = {busy} onClick={() => update("start")}>
          Start truck
          </Button>
          <Button disabled ={busy} onClick={() =>
            act(() => API.delete(`${url}/${p.id}`))}>
            Cancel
            </Button>
          </>}
        
        {p.owner && p.status === "in_transit" &&
          <Button disabled={busy} onClick={() =>
            next ? update("pickup", next.id) : update("arrive")}>
            {next ? `Pick up ${next.name}` : "Arrived at weighbridge"}
          </Button>}
        {p.arrivedAt && <p>Arrived: {time(p.arrivedAt)}</p>}
      </article>;
    })}
  </section>;
}