import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Truck, Plus, Search, Edit2, Trash2, Phone, FileBadge,
  Mail, MapPin, Package, Loader2, Building2
} from 'lucide-react'
import { toast } from 'sonner'
import api from '@/lib/api'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle
} from '@/components/ui/dialog'

// ─── Types ─────────────────────────────────────────────

interface Supplier {
  id: string
  name: string
  /** The shop's own reference for this distributor — `SUP-001`. */
  code?: string
  contactName?: string
  phone?: string
  email?: string
  gstNumber?: string
  address?: string
  city?: string
  state?: string
  pincode?: string
  drugLicenceNo?: string
  paymentTerms?: string
  deliveryDays?: string
  /** Decimal on the server; a number here, through the API's replacer. */
  creditLimit?: number
  notes?: string
  createdAt: string
}

// ─── Helpers ───────────────────────────────────────────

const inputCls = "bg-slate-700 border-slate-600 text-white placeholder:text-slate-500 focus:border-teal-500 h-9"

/** Whole rupees: a credit limit is negotiated in thousands, not paise. */
const formatINR = (v: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(v)

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-slate-300 text-sm">{label}</Label>
      {children}
    </div>
  )
}

const SUPPLIER_COLORS = [
  'from-teal-600 to-teal-800',
  'from-blue-600 to-blue-800',
  'from-purple-600 to-purple-800',
  'from-orange-600 to-orange-800',
  'from-rose-600 to-rose-800',
]

// ─── Main Suppliers Page ────────────────────────────────

export default function Suppliers() {
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<Supplier | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const EMPTY_FORM = {
    name: '', code: '', contactName: '', phone: '',
    email: '', gstNumber: '', address: '', city: '', state: '',
    pincode: '', drugLicenceNo: '', paymentTerms: '', deliveryDays: '',
    creditLimit: '', notes: '',
  }
  const [form, setForm] = useState(EMPTY_FORM)

  const queryClient = useQueryClient()

  // Keyed on `search`, so the server-side filter gets its own cache entry and a
  // request for a term the user has already backspaced past is cancelled rather
  // than left to land on top of the current one.
  const { data: suppliers = [], isLoading: loading } = useQuery<Supplier[]>({
    queryKey: ['suppliers', search],
    queryFn: async ({ signal }) => {
      const params = search ? `?search=${search}` : ''
      const res = await api.get(`/api/suppliers${params}`, { signal })
      return res.data.data
    },
    meta: { errorMessage: 'Failed to fetch suppliers' },
  })

  const openAdd = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  const handleDelete = async (s: Supplier) => {
    if (!confirm(`Delete ${s.name}?`)) return
    try {
      await api.delete(`/api/suppliers/${s.id}`)
      toast.success('Supplier deleted')
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
    } catch (err) {
      // The server distinguishes "still has stock against it" (409) from
      // "not an administrator" (403); repeating its sentence keeps those two
      // from arriving as one vague failure.
      const e = err as { response?: { data?: { message?: string } } }
      toast.error(e.response?.data?.message || 'Failed to delete the supplier')
    }
  }

  const openEdit = (s: Supplier) => {
    setEditing(s)
    setForm({
      name: s.name, code: s.code || '', contactName: s.contactName || '',
      phone: s.phone || '', email: s.email || '',
      gstNumber: s.gstNumber || '', address: s.address || '',
      city: s.city || '', state: s.state || '', pincode: s.pincode || '',
      drugLicenceNo: s.drugLicenceNo || '',
      paymentTerms: s.paymentTerms || '', deliveryDays: s.deliveryDays || '',
      creditLimit: s.creditLimit != null ? String(s.creditLimit) : '',
      notes: s.notes || '',
    })
    setShowForm(true)
  }

  /**
   * The form's shape is not the API's, in two ways that both matter.
   *
   * **An untouched field is omitted, not sent as `''`.** `code` is unique per
   * shop, and an empty string is a *value* — two suppliers saved with a blank
   * code would collide on the unique index and the second would come back 409
   * for a field nobody filled in. Postgres treats NULLs as distinct, so the
   * absent case has to actually be absent.
   *
   * **`creditLimit` leaves as a number.** It is typed into a text box and the
   * schema wants a number; a blank one is no limit rather than zero, which is
   * a different claim.
   */
  const toPayload = (f: typeof EMPTY_FORM) => {
    const { creditLimit, ...rest } = f
    const payload: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rest)) {
      if (value.trim() !== '') payload[key] = value.trim()
    }
    if (creditLimit.trim() !== '') payload.creditLimit = Number(creditLimit)
    return payload
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (form.creditLimit.trim() !== '' && !Number.isFinite(Number(form.creditLimit))) {
      toast.error('Credit limit must be a number')
      return
    }

    setSubmitting(true)
    try {
      if (editing) {
        await api.put(`/api/suppliers/${editing.id}`, toPayload(form))
        toast.success('Supplier updated!')
      } else {
        await api.post('/api/suppliers', toPayload(form))
        toast.success('Supplier added!')
      }
      setShowForm(false)
      queryClient.invalidateQueries({ queryKey: ['suppliers'] })
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } }
      toast.error(e.response?.data?.message || 'Failed to save')
    } finally { setSubmitting(false) }
  }

  const filtered = suppliers.filter(s =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.phone?.includes(search) ||
    s.contactName?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Suppliers</h2>
          <p className="text-slate-400 mt-1 text-sm">Manage your medicine suppliers and vendors</p>
        </div>
        <Button onClick={openAdd} className="bg-teal-600 hover:bg-teal-500 text-black">
          <Plus className="w-4 h-4 mr-1" /> Add Supplier
        </Button>
      </div>

      <Separator className="bg-slate-800" />

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search suppliers..."
            className={`pl-9 ${inputCls}`} />
        </div>
        <Badge className="bg-slate-700 text-slate-300">{filtered.length} suppliers</Badge>
      </div>

      {/* Suppliers Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading suppliers...
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-slate-500">
          <Truck className="w-12 h-12 mb-3 opacity-20" />
          <p>No suppliers found</p>
          <Button onClick={openAdd} size="sm"
            className="mt-3 bg-teal-600 hover:bg-teal-500 text-black">
            Add First Supplier
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((s, idx) => (
            <Card key={s.id}
              className="bg-slate-800 border-slate-700 hover:border-slate-600 transition-all group overflow-hidden">

              {/* Color Bar */}
              <div className={`h-1.5 bg-gradient-to-r ${SUPPLIER_COLORS[idx % SUPPLIER_COLORS.length]}`} />

              <CardContent className="pt-4 pb-4">

                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl bg-gradient-to-br
                      ${SUPPLIER_COLORS[idx % SUPPLIER_COLORS.length]}
                      flex items-center justify-center shrink-0`}>
                      <Building2 className="w-5 h-5 text-white" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-white font-semibold text-sm truncate">
                          {s.name}
                        </p>
                        {s.code && (
                          <span className="text-[10px] font-mono text-slate-500 shrink-0">
                            {s.code}
                          </span>
                        )}
                      </div>
                      {s.contactName && (
                        <p className="text-slate-400 text-xs">{s.contactName}</p>
                      )}
                    </div>
                  </div>
                  {/* See Customers.tsx: the hover reveal only applies where a
                      pointer exists, or a touch device can never reach Edit. */}
                  <div className="shrink-0 flex items-center gap-1 transition-all [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100">
                    <button
                      onClick={() => openEdit(s)}
                      aria-label={`Edit ${s.name}`}
                      className="p-2 sm:p-1.5 rounded-md text-slate-400 hover:text-teal-400 hover:bg-slate-700 transition-colors"
                    >
                      <Edit2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(s)}
                      aria-label={`Delete ${s.name}`}
                      className="p-2 sm:p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors"
                    >
                      <Trash2 className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
                    </button>
                  </div>
                </div>

                <Separator className="bg-slate-700 mb-3" />

                {/* Contact Details */}
                <div className="space-y-1.5 text-xs">
                  {s.phone && (
                    <div className="flex items-center gap-2 text-slate-400">
                      <Phone className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span>{s.phone}</span>
                    </div>
                  )}
                  {s.email && (
                    <div className="flex items-center gap-2 text-slate-400">
                      <Mail className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="truncate">{s.email}</span>
                    </div>
                  )}
                  {(s.address || s.city) && (
                    <div className="flex items-center gap-2 text-slate-400">
                      <MapPin className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      {/* Joined here rather than stored joined: the parts are
                          separate columns because they are searched on, and a
                          card wants one line. */}
                      <span className="truncate">
                        {[s.address, s.city, s.state, s.pincode]
                          .filter(Boolean)
                          .join(', ')}
                      </span>
                    </div>
                  )}
                  {s.gstNumber && (
                    <div className="flex items-center gap-2">
                      <Package className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <Badge className="bg-slate-700 text-slate-300 text-xs px-1.5 py-0 font-mono">
                        {s.gstNumber}
                      </Badge>
                    </div>
                  )}
                  {s.drugLicenceNo && (
                    <div className="flex items-center gap-2 text-slate-400">
                      <FileBadge className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span className="truncate font-mono text-[11px]">
                        {s.drugLicenceNo}
                      </span>
                    </div>
                  )}
                  {(s.paymentTerms || s.deliveryDays || s.creditLimit != null) && (
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {s.paymentTerms && (
                        <Badge className="bg-slate-700 text-slate-300 text-[10px] px-1.5 py-0">
                          {s.paymentTerms}
                        </Badge>
                      )}
                      {s.deliveryDays && (
                        <Badge className="bg-slate-700 text-slate-300 text-[10px] px-1.5 py-0">
                          {s.deliveryDays}
                        </Badge>
                      )}
                      {s.creditLimit != null && (
                        <Badge className="bg-slate-700 text-slate-300 text-[10px] px-1.5 py-0 tabular-nums">
                          Limit {formatINR(s.creditLimit)}
                        </Badge>
                      )}
                    </div>
                  )}
                  {s.notes && (
                    <p className="text-slate-500 text-[11px] pt-0.5 line-clamp-2">
                      {s.notes}
                    </p>
                  )}
                </div>

                {/* Footer */}
                <div className="mt-3 pt-3 border-t border-slate-700 flex items-center justify-between">
                  <p className="text-slate-500 text-xs">
                    Added {new Date(s.createdAt).toLocaleDateString('en-IN', {
                      day: '2-digit', month: 'short', year: 'numeric'
                    })}
                  </p>
                  <Badge className="bg-teal-900/40 text-teal-400 text-xs">Active</Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-black-900 border-slate-700 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Supplier' : 'Add New Supplier'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3 mt-2">
            <Field label="Supplier Name *">
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                required placeholder="Company / Distributor name" className={inputCls} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Contact Person">
                <Input value={form.contactName}
                  onChange={e => setForm({ ...form, contactName: e.target.value })}
                  placeholder="Rep name" className={inputCls} />
              </Field>
              <Field label="Phone">
                <Input value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  placeholder="Mobile / Landline" className={inputCls} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Email">
                <Input type="email" value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  placeholder="email@company.com" className={inputCls} />
              </Field>
              <Field label="GST Number">
                <Input value={form.gstNumber}
                  onChange={e => setForm({ ...form, gstNumber: e.target.value })}
                  placeholder="27AAPFU0939F1ZV" className={inputCls} />
              </Field>
            </div>
            <Field label="Address">
              <Input value={form.address}
                onChange={e => setForm({ ...form, address: e.target.value })}
                placeholder="Street / shop number" className={inputCls} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="City">
                <Input value={form.city}
                  onChange={e => setForm({ ...form, city: e.target.value })}
                  placeholder="Patna" className={inputCls} />
              </Field>
              <Field label="State">
                <Input value={form.state}
                  onChange={e => setForm({ ...form, state: e.target.value })}
                  placeholder="Bihar" className={inputCls} />
              </Field>
              <Field label="PIN Code">
                <Input value={form.pincode} inputMode="numeric" maxLength={6}
                  onChange={e => setForm({ ...form, pincode: e.target.value })}
                  placeholder="800004" className={inputCls} />
              </Field>
            </div>

            <Separator className="bg-slate-700" />
            {/* The commercial half of a distributor card. All optional: a
                supplier is usually entered from a phone number and filled in
                later from the first invoice. */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Supplier Code">
                <Input value={form.code}
                  onChange={e => setForm({ ...form, code: e.target.value })}
                  placeholder="SUP-001" className={inputCls} />
              </Field>
              <Field label="Drug Licence No.">
                <Input value={form.drugLicenceNo}
                  onChange={e => setForm({ ...form, drugLicenceNo: e.target.value })}
                  placeholder="BR/PAT/20B-2214, 21B-2215" className={inputCls} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Payment Terms">
                <Input value={form.paymentTerms}
                  onChange={e => setForm({ ...form, paymentTerms: e.target.value })}
                  placeholder="30 days credit" className={inputCls} />
              </Field>
              <Field label="Delivery Days">
                <Input value={form.deliveryDays}
                  onChange={e => setForm({ ...form, deliveryDays: e.target.value })}
                  placeholder="Mon, Wed, Fri" className={inputCls} />
              </Field>
              <Field label="Credit Limit (₹)">
                <Input value={form.creditLimit} inputMode="decimal"
                  onChange={e => setForm({ ...form, creditLimit: e.target.value })}
                  placeholder="250000" className={inputCls} />
              </Field>
            </div>
            <Field label="Notes">
              <Input value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                placeholder="What they carry, how they deliver" className={inputCls} />
            </Field>
            <Separator className="bg-slate-700" />
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}
                className="border-slate-600 text-slate-300 hover:bg-slate-700">Cancel</Button>
              <Button type="submit" disabled={submitting}
                className="bg-teal-600 hover:bg-teal-500 text-black">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {editing ? 'Update' : 'Add Supplier'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}